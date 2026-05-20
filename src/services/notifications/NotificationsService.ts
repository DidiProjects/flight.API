import { FlightOfferRow, RoutineRow, BestFareRow } from '../../types'
import { INotificationsService } from './interfaces/INotificationsService'
import { INotificationLogRepository } from './interfaces/INotificationLogRepository'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IBestFaresRepository } from '../../modules/scrape/interfaces/IBestFaresRepository'
import { IUnsubscribeTokensRepository } from '../../modules/unsubscribe/interfaces/IUnsubscribeTokensRepository'
import { IUsersRepository } from '../../modules/users/interfaces/IUsersRepository'
import { IEmailService, OfferBlock } from '../email/interfaces/IEmailService'
import { Env } from '../../config/env'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'notifications' })

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
    const ctx = {
      routineId: routine.id,
      userId: routine.user_id,
      routineName: routine.name,
      airline: routine.airline,
      origin: routine.origin,
      destination: routine.destination,
      mode: routine.notification_mode,
      priority: routine.priority,
    }

    if (routine.notification_mode === 'end_of_period') {
      log.debug(ctx, 'evaluate skipped — end_of_period mode (handled by scheduler)')
      return
    }

    const hasTargetHit = offers.some((o) => o.within_target)
    if (routine.notification_mode === 'alert_only' && !hasTargetHit) {
      log.info({ ...ctx, offerCount: offers.length }, 'no notification — alert_only, no offers within target')
      return
    }

    const [bestOut, bestRet] = await Promise.all([
      this.bestFaresRepo.getBest(routine.id, false, routine.priority),
      routine.return_start
        ? this.bestFaresRepo.getBest(routine.id, true, routine.priority)
        : Promise.resolve(null),
    ])

    if (!bestOut) {
      log.warn(ctx, 'no notification — best outbound fare not found')
      return
    }

    const lastLog = await this.notifLogRepo.findLast(routine.id, routine.priority)
    if (!this.improved(bestOut, bestRet, lastLog)) {
      log.info({
        ...ctx,
        bestOutAmount: bestOut.amount,
        lastOutAmount: lastLog?.outbound_amount ?? null,
        bestRetAmount: bestRet?.amount ?? null,
        lastRetAmount: lastLog?.return_amount ?? null,
        status: 'skipped',
      }, 'no notification — fares not improved since last notification')
      return
    }

    const shouldAlert =
      (routine.notification_mode === 'alert_only' && hasTargetHit) ||
      (routine.notification_mode === 'daily_best_and_alert' && hasTargetHit)

    if (!shouldAlert) {
      log.debug({ ...ctx, hasTargetHit, bestOutAmount: bestOut.amount }, 'fares improved but no alert — will notify at daily_best time')
      return
    }

    if (routine.notification_frequency !== 'hourly') {
      const since = this.frequencyWindowStart(routine.notification_frequency)
      const alreadySent = await this.notifLogRepo.hasAlertSince(routine.id, routine.priority, since)
      if (alreadySent) {
        log.info({ ...ctx, frequency: routine.notification_frequency, since, status: 'skipped' }, 'no notification — frequency limit reached for this period')
        return
      }
    }

    await this.dispatch(routine, bestOut, bestRet, 'alert')
  }

  async sendEndOfPeriod(): Promise<void> {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(now)
    const currentTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

    const routines = await this.routinesRepo.findActiveForEndOfPeriod(currentTime)
    if (routines.length > 0) {
      log.info({ routineCount: routines.length, currentTime }, 'sending end-of-period notifications')
    }

    for (const routine of routines) {
      const [bestOut, bestRet] = await Promise.all([
        this.bestFaresRepo.getBest(routine.id, false, routine.priority),
        routine.return_start
          ? this.bestFaresRepo.getBest(routine.id, true, routine.priority)
          : Promise.resolve(null),
      ])
      if (!bestOut) {
        log.warn({ routineId: routine.id, userId: routine.user_id, airline: routine.airline, origin: routine.origin, destination: routine.destination, status: 'skipped' }, 'end_of_period skipped — no best fare found')
        continue
      }
      await this.dispatch(routine, bestOut, bestRet, 'end_of_period')
    }
  }

  async sendDailyBest(): Promise<void> {
    const routines = await this.routinesRepo.findActiveForDailyBest()
    log.info({ routineCount: routines.length }, 'sending daily best notifications')

    for (const routine of routines) {
      const [bestOut, bestRet] = await Promise.all([
        this.bestFaresRepo.getBest(routine.id, false, routine.priority),
        routine.return_start
          ? this.bestFaresRepo.getBest(routine.id, true, routine.priority)
          : Promise.resolve(null),
      ])

      if (!bestOut) {
        log.warn({ routineId: routine.id, userId: routine.user_id, airline: routine.airline, origin: routine.origin, destination: routine.destination, status: 'skipped' }, 'daily_best skipped — no best fare found')
        continue
      }

      if (!this.fareWithinTarget(bestOut, routine)) {
        log.info({ routineId: routine.id, userId: routine.user_id, airline: routine.airline, origin: routine.origin, destination: routine.destination, bestAmount: bestOut.amount, status: 'skipped' }, 'daily_best skipped — best fare not within target')
        continue
      }

      const lastDailyBest = await this.notifLogRepo.findLastByType(routine.id, routine.priority, 'best_of_day')
      if (
        lastDailyBest &&
        lastDailyBest.outbound_amount === bestOut.amount &&
        (lastDailyBest.return_amount ?? null) === (bestRet?.amount ?? null)
      ) {
        log.info({ routineId: routine.id, userId: routine.user_id, airline: routine.airline, origin: routine.origin, destination: routine.destination, amount: bestOut.amount, status: 'skipped' }, 'daily_best skipped — price unchanged since last daily best')
        continue
      }

      await this.dispatch(routine, bestOut, bestRet, 'best_of_day')
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private fareWithinTarget(bestOut: BestFareRow, routine: RoutineRow): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash' && routine.target_cash != null)
      return bestOut.amount <= routine.target_cash * t
    if (routine.priority === 'pts' && routine.target_pts != null)
      return bestOut.amount <= routine.target_pts * t
    if (routine.priority === 'hyb' && routine.target_hyb_pts != null && routine.target_hyb_cash != null)
      return bestOut.offer.fare_hyb_pts != null &&
             bestOut.offer.fare_hyb_cash != null &&
             bestOut.offer.fare_hyb_pts  <= routine.target_hyb_pts  * t &&
             bestOut.offer.fare_hyb_cash <= routine.target_hyb_cash * t
    return false
  }

  private frequencyWindowStart(frequency: string): Date {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    if (frequency === 'daily')   return new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (frequency === 'monthly') return new Date(now.getFullYear(), now.getMonth(), 1)
    return new Date(0)
  }

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
    if (!owner) {
      log.warn({ routineId: routine.id, userId: routine.user_id, airline: routine.airline, origin: routine.origin, destination: routine.destination, type, status: 'error' }, 'dispatch skipped — user not found')
      return
    }

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
      primaryEmail:     owner.email,
      primaryUnsubLink: `${this.env.API_BASE_URL}/unsubscribe/${primaryToken}`,
      ccRecipients:     ccTokens,
      subject:          labels[type],
      routineName:      routine.name,
      origin:           routine.origin,
      destination:      routine.destination,
      outboundOffer:    bestOut  ? this.toBlock(bestOut)  : null,
      returnOffer:      bestRet  ? this.toBlock(bestRet)  : null,
      passengers:       routine.passengers,
      fareType:         routine.priority,
      airline:          routine.airline,
      currency:         bestOut.currency,
    })

    log.info({
      routineId:      routine.id,
      userId:         owner.id,
      routineName:    routine.name,
      airline:        routine.airline,
      origin:         routine.origin,
      destination:    routine.destination,
      type,
      priority:       routine.priority,
      outboundAmount: bestOut.amount,
      returnAmount:   bestRet?.amount ?? null,
      currency:       bestOut.currency,
      emailTo:        owner.email,
      ccCount:        activeCc.length,
      status:         'success',
    }, 'notification dispatched')

    await this.notifLogRepo.insert({
      routineId:      routine.id,
      type,
      fareType:       routine.priority,
      outboundAmount: bestOut?.amount ?? null,
      returnAmount:   bestRet?.amount ?? null,
      emailTo:        owner.email,
      emailCc:        activeCc.map((c) => c.email).join(',') || null,
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
      fareCash:      bf.offer.fare_cash,
      farePts:       bf.offer.fare_pts,
      fareHybPts:    bf.offer.fare_hyb_pts,
      fareHybCash:   bf.offer.fare_hyb_cash,
    }
  }
}
