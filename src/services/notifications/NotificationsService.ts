import { RoutineRow } from '../../types'
import { INotificationsService } from './interfaces/INotificationsService'
import { INotificationLogRepository } from './interfaces/INotificationLogRepository'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate, PriceHistory } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { IUnsubscribeTokensRepository } from '../../modules/unsubscribe/interfaces/IUnsubscribeTokensRepository'
import { IUsersRepository } from '../../modules/users/interfaces/IUsersRepository'
import { IEmailService, AirlineOfferPair, DailyBestRoutineSection, OfferBlock } from '../email/interfaces/IEmailService'
import { Env } from '../../config/env'
import { logger } from '../../utils/logger'
import { toDateStr } from '../evaluation/EvaluationService'

const log = logger.child({ service: 'notifications' })

export class NotificationsService implements INotificationsService {
  constructor(
    private readonly usersRepo: IUsersRepository,
    private readonly routinesRepo: IRoutinesRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly notifLogRepo: INotificationLogRepository,
    private readonly unsubTokensRepo: IUnsubscribeTokensRepository,
    private readonly emailSvc: IEmailService,
    private readonly env: Env,
  ) {}

  async sendScheduled(): Promise<void> {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(now)
    const currentTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

    const routines = await this.routinesRepo.findActiveForScheduled(currentTime)
    if (routines.length > 0) {
      log.info({ routineCount: routines.length, currentTime }, 'sending scheduled notifications')
    }

    const byUser = new Map<string, RoutineRow[]>()
    for (const r of routines) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
      byUser.get(r.user_id)!.push(r)
    }

    for (const [userId, userRoutines] of byUser) {
      const owner = await this.usersRepo.findById(userId)
      if (!owner) {
        log.warn({ userId }, 'scheduled skipped — user not found')
        continue
      }

      const sections: DailyBestRoutineSection[] = []
      const logEntries: Array<{ routine: RoutineRow; bestFare: LatestFaresByDate }> = []

      for (const routine of userRoutines) {
        // Catch-up usa match `<=` no horário, então deduplicamos aqui: se já houve
        // um envio 'scheduled' nas últimas 12h, não reenvia (frequência é diária).
        if (await this.notifLogRepo.hasNotificationSinceHours(routine.id, 'scheduled', 12)) {
          continue
        }

        const allOutbound: LatestFaresByDate[] = []

        for (const airline of routine.airlines) {
          const outbound = await this.flightFaresRepo.getLatestByRoute(
            airline,
            routine.origin,
            routine.destination,
            toDateStr(routine.outbound_start),
            toDateStr(routine.outbound_end),
          )
          allOutbound.push(...outbound)
        }

        if (allOutbound.length === 0) {
          log.warn({ routineId: routine.id, userId, status: 'skipped' }, 'scheduled routine skipped — no fares found')
          continue
        }

        const bestOutbound = this.bestFare(allOutbound, routine.priority)
        if (!bestOutbound) continue

        const unsubToken = await this.unsubTokensRepo.create(routine.id, owner.email, true)

        sections.push({
          routineName:  routine.name,
          origin:       routine.origin,
          destination:  routine.destination,
          passengers:   routine.passengers,
          fareType:     routine.priority,
          airlineOffers: [{
            airline:  bestOutbound.airline,
            currency: bestOutbound.currency ?? routine.currency ?? 'BRL',
            outbound: this.fareToBlock(bestOutbound, routine.origin, routine.destination),
            return:   null,
          }],
          unsubLink: `${this.env.API_BASE_URL}/unsubscribe/${unsubToken}`,
        })

        logEntries.push({ routine, bestFare: bestOutbound })
      }

      if (sections.length === 0) {
        log.info({ userId, status: 'skipped' }, 'scheduled skipped — no routines with available fares')
        continue
      }

      await this.emailSvc.sendDailyBest({ primaryEmail: owner.email, routines: sections })

      for (const { routine, bestFare } of logEntries) {
        log.info({
          routineId:      routine.id,
          userId,
          routineName:    routine.name,
          airline:        bestFare.airline,
          type:           'scheduled',
          outboundAmount: this.fareAmount(bestFare, routine.priority),
          status:         'success',
        }, 'scheduled notification dispatched')

        await this.notifLogRepo.insert({
          routineId:      routine.id,
          airline:        bestFare.airline,
          type:           'scheduled',
          fareType:       routine.priority,
          outboundAmount: this.fareAmount(bestFare, routine.priority),
          returnAmount:   null,
          emailTo:        owner.email,
          emailCc:        null,
        })
      }
    }
  }

  async dispatchAlert(
    routine: RoutineRow,
    outboundFares: LatestFaresByDate[],
    history: PriceHistory,
  ): Promise<void> {
    if (outboundFares.length === 0) return

    const owner = await this.usersRepo.findById(routine.user_id)
    if (!owner) {
      log.warn({ routineId: routine.id, userId: routine.user_id }, 'dispatchAlert skipped — user not found')
      return
    }

    const activeCc = routine.cc_emails.filter((c) => c.subscribed)
    const primaryToken = await this.unsubTokensRepo.create(routine.id, owner.email, true)
    const ccTokens = await Promise.all(
      activeCc.map(async (c) => ({
        email: c.email,
        unsubLink: `${this.env.API_BASE_URL}/unsubscribe/${await this.unsubTokensRepo.create(routine.id, c.email, false)}`,
      })),
    )

    // Headline = oferta mais barata; empate de preço → tarifa coletada mais
    // recentemente (scraped_at). O histórico (% abaixo da média) é dela.
    const headline = outboundFares.reduce((best, f) => {
      const fv = this.fareAmount(f, routine.priority) ?? Infinity
      const bv = this.fareAmount(best, routine.priority) ?? Infinity
      if (fv < bv) return f
      if (fv === bv && new Date(f.scraped_at).getTime() > new Date(best.scraped_at).getTime()) return f
      return best
    })
    const historyNote = this.buildHistoryNote(headline, history, routine.priority)

    // Apenas UMA tarifa por rotina no email: a headline. As demais datas que
    // avançaram já foram gravadas no watermark (target_alert_state) pelo
    // EvaluationService — só não são exibidas aqui.
    const airlineOffers: AirlineOfferPair[] = [{
      airline:  headline.airline,
      currency: headline.currency ?? routine.currency ?? 'BRL',
      outbound: this.fareToBlock(headline, routine.origin, routine.destination),
      return:   null,
    }]

    await this.emailSvc.sendFlightAlert({
      primaryEmail:     owner.email,
      primaryUnsubLink: `${this.env.API_BASE_URL}/unsubscribe/${primaryToken}`,
      ccRecipients:     ccTokens,
      subject:          `Oferta dentro do target — ${routine.name}`,
      routineName:      routine.name,
      origin:           routine.origin,
      destination:      routine.destination,
      airlineOffers,
      passengers:       routine.passengers,
      fareType:         routine.priority,
      historyNote,
    })

    log.info({
      routineId:       routine.id,
      userId:          owner.id,
      routineName:     routine.name,
      dates:           outboundFares.map((f) => toDateStr(f.flight_date)),
      headlineAirline: headline.airline,
      headlineAmount:  this.fareAmount(headline, routine.priority),
      avgCash30d:      history.avg_cash_30d,
      type:            'alert',
      status:          'success',
    }, 'evaluation alert dispatched')

    await this.notifLogRepo.insert({
      routineId:      routine.id,
      airline:        headline.airline,
      type:           'alert',
      fareType:       routine.priority,
      outboundAmount: this.fareAmount(headline, routine.priority),
      returnAmount:   null,
      emailTo:        owner.email,
      emailCc:        activeCc.map((c) => c.email).join(',') || null,
    })
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private bestFare(fares: LatestFaresByDate[], priority: string): LatestFaresByDate | null {
    const withValue = fares.filter((f) => this.fareAmount(f, priority) !== null)
    if (withValue.length === 0) return null
    return withValue.reduce((best, curr) => {
      const bv = this.fareAmount(best, priority)!
      const cv = this.fareAmount(curr, priority)!
      return cv < bv ? curr : best
    })
  }

  private fareToBlock(fare: LatestFaresByDate, origin: string, destination: string): OfferBlock {
    return {
      flightNumber:  '',
      date:          toDateStr(fare.flight_date),
      origin,
      departureTime: fare.departure_time ?? '',
      destination,
      arrivalTime:   fare.arrival_time ?? '',
      durationMin:   fare.duration_min ?? 0,
      stops:         fare.stops ?? 0,
      fareCash:      fare.fare_cash,
      farePts:       fare.fare_pts,
      fareHybPts:    fare.fare_hyb_pts,
      fareHybCash:   fare.fare_hyb_cash,
    }
  }

  private fareAmount(fare: LatestFaresByDate, priority: string): number | null {
    // NUMERIC volta do pg como string — coagir para Number, senão a comparação
    // do bestFare vira lexicográfica ("1076.00" < "652.00" === true).
    const raw =
      priority === 'cash' ? fare.fare_cash :
      priority === 'pts'  ? fare.fare_pts :
      priority === 'hyb'  ? fare.fare_hyb_pts :
      null
    return raw == null ? null : Number(raw)
  }

  private buildHistoryNote(fare: LatestFaresByDate, history: PriceHistory, priority: string): string | undefined {
    if (priority === 'cash' && fare.fare_cash != null && history.avg_cash_30d != null) {
      const avg = Number(history.avg_cash_30d)
      const pct = Math.round(((avg - fare.fare_cash) / avg) * 100)
      if (pct > 0) return `${pct}% abaixo da média dos últimos 30 dias`
    }
    if (priority === 'pts' && fare.fare_pts != null && history.avg_pts_30d != null) {
      const avg = Number(history.avg_pts_30d)
      const pct = Math.round(((avg - fare.fare_pts) / avg) * 100)
      if (pct > 0) return `${pct}% abaixo da média dos últimos 30 dias`
    }
    return undefined
  }

}
