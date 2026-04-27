import { FlightOfferRow, RoutineRow, BestFareRow } from '../../types'
import { INotificationsService } from './interfaces/INotificationsService'
import { INotificationLogRepository } from './interfaces/INotificationLogRepository'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IBestFaresRepository } from '../../modules/scrape/interfaces/IBestFaresRepository'
import { IUnsubscribeTokensRepository } from '../../modules/unsubscribe/interfaces/IUnsubscribeTokensRepository'
import { IUsersRepository } from '../../modules/users/interfaces/IUsersRepository'
import { IEmailService, OfferBlock } from '../email/interfaces/IEmailService'
import { Env } from '../../config/env'

type AlertType = 'alert' | 'best_of_day' | 'end_of_period'

export class NotificationsService implements INotificationsService {
  constructor(
    private readonly usersRepo: IUsersRepository,
    private readonly routinesRepo: IRoutinesRepository,
    private readonly bestFaresRepo: IBestFaresRepository,
    private readonly notifLogRepo: INotificationLogRepository,
    private readonly unsubTokensRepo: IUnsubscribeTokensRepository,
    private readonly emailSvc: IEmailService,
    private readonly env: Env,
  ) {}

  async evaluate(routine: RoutineRow, offers: FlightOfferRow[]): Promise<void> {
    if (routine.notification_mode === 'end_of_period') return

    const hasTargetHit = offers.some((o) => o.within_target)
    if (routine.notification_mode === 'alert_only' && !hasTargetHit) return

    const [bestOut, bestRet] = await Promise.all([
      this.bestFaresRepo.getBest(routine.id, false, routine.priority),
      routine.return_start
        ? this.bestFaresRepo.getBest(routine.id, true, routine.priority)
        : Promise.resolve(null),
    ])

    if (!bestOut) return

    const lastLog = await this.notifLogRepo.findLast(routine.id, routine.priority)
    if (!this.improved(bestOut, bestRet, lastLog)) return

    if (routine.notification_mode === 'alert_only' && hasTargetHit) {
      await this.dispatch(routine, bestOut, bestRet, 'alert')
    } else if (routine.notification_mode === 'daily_best_and_alert' && hasTargetHit) {
      await this.dispatch(routine, bestOut, bestRet, 'alert')
    }
  }

  async sendEndOfPeriod(): Promise<void> {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(now)
    const currentTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

    const routines = await this.routinesRepo.findActiveForEndOfPeriod(currentTime)
    for (const routine of routines) {
      const [bestOut, bestRet] = await Promise.all([
        this.bestFaresRepo.getBest(routine.id, false, routine.priority),
        routine.return_start
          ? this.bestFaresRepo.getBest(routine.id, true, routine.priority)
          : Promise.resolve(null),
      ])
      if (!bestOut) continue
      await this.dispatch(routine, bestOut, bestRet, 'end_of_period')
    }
  }

  async sendDailyBest(): Promise<void> {
    const routines = await this.routinesRepo.findActiveForDailyBest()
    for (const routine of routines) {
      const [bestOut, bestRet] = await Promise.all([
        this.bestFaresRepo.getBest(routine.id, false, routine.priority),
        routine.return_start
          ? this.bestFaresRepo.getBest(routine.id, true, routine.priority)
          : Promise.resolve(null),
      ])
      if (!bestOut) continue
      await this.dispatch(routine, bestOut, bestRet, 'best_of_day')
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private improved(
    out: BestFareRow,
    ret: BestFareRow | null,
    last: { outbound_amount: number | null; return_amount: number | null } | null,
  ): boolean {
    if (!last) return true
    const outBetter = last.outbound_amount != null ? out.amount < last.outbound_amount : true
    const retBetter = ret != null
      ? (last.return_amount != null ? ret.amount < last.return_amount : true)
      : false
    return outBetter || retBetter
  }

  private async dispatch(
    routine: RoutineRow,
    bestOut: BestFareRow,
    bestRet: BestFareRow | null,
    type: AlertType,
  ): Promise<void> {
    const owner = await this.usersRepo.findById(routine.user_id)
    if (!owner) return

    const labels: Record<AlertType, string> = {
      alert:         `Oferta dentro do target — ${routine.name}`,
      best_of_day:   `Melhor preço do dia — ${routine.name}`,
      end_of_period: `Resumo do período — ${routine.name}`,
    }

    const activeCc = routine.cc_emails.filter((c) => c.subscribed)
    const primaryToken = await this.unsubTokensRepo.create(routine.id, owner.email, true)
    const ccTokens = await Promise.all(
      activeCc.map(async (c) => ({
        email: c.email,
        unsubLink: `${this.env.API_BASE_URL}/unsubscribe/${await this.unsubTokensRepo.create(routine.id, c.email, false)}`,
      })),
    )

    await this.emailSvc.sendFlightAlert({
      primaryEmail:    owner.email,
      primaryUnsubLink: `${this.env.API_BASE_URL}/unsubscribe/${primaryToken}`,
      ccRecipients:    ccTokens,
      subject:         labels[type],
      routineName:     routine.name,
      origin:          routine.origin,
      destination:     routine.destination,
      outboundOffer:   bestOut  ? this.toBlock(bestOut)  : null,
      returnOffer:     bestRet  ? this.toBlock(bestRet)  : null,
      passengers:      routine.passengers,
      fareType:        routine.priority,
      airline:         routine.airline,
    })

    await this.notifLogRepo.insert({
      routineId:       routine.id,
      type,
      fareType:        routine.priority,
      outboundAmount:  bestOut?.amount ?? null,
      returnAmount:    bestRet?.amount ?? null,
      emailTo:         owner.email,
      emailCc:         activeCc.map((c) => c.email).join(',') || null,
    })
  }

  private toBlock(bf: BestFareRow): OfferBlock {
    return {
      flightNumber:  bf.offer.flight_number,
      date:          bf.offer.date,
      origin:        bf.offer.origin_iata,
      departureTime: bf.offer.origin_timestamp,
      destination:   bf.offer.destination_iata,
      arrivalTime:   bf.offer.destination_timestamp,
      durationMin:   bf.offer.duration_min,
      stops:         bf.offer.stops,
      fareBrl:       bf.offer.fare_brl,
      farePts:       bf.offer.fare_pts,
      fareHybPts:    bf.offer.fare_hyb_pts,
      fareHybBrl:    bf.offer.fare_hyb_brl,
    }
  }
}
