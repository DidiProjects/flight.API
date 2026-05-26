import { BestFareRow, RoutineRow } from '../../types'
import { INotificationsService } from './interfaces/INotificationsService'
import { INotificationLogRepository } from './interfaces/INotificationLogRepository'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IBestFaresRepository } from '../../modules/scrape/interfaces/IBestFaresRepository'
import { IUnsubscribeTokensRepository } from '../../modules/unsubscribe/interfaces/IUnsubscribeTokensRepository'
import { IUsersRepository } from '../../modules/users/interfaces/IUsersRepository'
import { IEmailService, AirlineOfferPair, DailyBestRoutineSection, OfferBlock } from '../email/interfaces/IEmailService'
import { Env } from '../../config/env'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'notifications' })

type AlertType = 'alert' | 'best_of_day' | 'end_of_period'
type QualifyingAirline = { outbound: BestFareRow; return: BestFareRow | null }

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

  async evaluate(routine: RoutineRow): Promise<void> {
    const ctx = {
      routineId: routine.id,
      userId: routine.user_id,
      routineName: routine.name,
      airlines: routine.airlines,
      origin: routine.origin,
      destination: routine.destination,
      mode: routine.notification_mode,
      priority: routine.priority,
    }

    if (routine.notification_mode === 'end_of_period') {
      log.debug(ctx, 'evaluate skipped — end_of_period mode (handled by scheduler)')
      return
    }

    const [bestOut, bestRet] = await Promise.all([
      this.bestFaresRepo.getBestPerAirline(routine.id, false, routine.priority),
      routine.return_start
        ? this.bestFaresRepo.getBestPerAirline(routine.id, true, routine.priority)
        : Promise.resolve([]),
    ])

    if (bestOut.length === 0) {
      await this.checkStale(routine.id, routine.priority, ctx)
      log.warn(ctx, 'no notification — no best fares found')
      return
    }

    const retByAirline = Object.fromEntries(bestRet.map((b) => [b.airline, b]))

    const qualifying: QualifyingAirline[] = []
    for (const out of bestOut) {
      const ret = retByAirline[out.airline] ?? null
      if (!this.fareWithinTarget(out, routine)) continue
      const lastLog = await this.notifLogRepo.findLast(routine.id, routine.priority, out.airline)
      if (!this.improved(out, ret, lastLog)) {
        log.info({ ...ctx, airline: out.airline, bestOutAmount: out.amount, lastOutAmount: lastLog?.outbound_amount ?? null }, 'airline skipped — not improved')
        continue
      }
      qualifying.push({ outbound: out, return: ret })
    }

    if (qualifying.length === 0) {
      log.info(ctx, 'no notification — no qualifying airlines')
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

    await this.dispatch(routine, qualifying, 'alert')
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
        this.bestFaresRepo.getBestPerAirline(routine.id, false, routine.priority),
        routine.return_start
          ? this.bestFaresRepo.getBestPerAirline(routine.id, true, routine.priority)
          : Promise.resolve([]),
      ])

      if (bestOut.length === 0) {
        const ctx = { routineId: routine.id, userId: routine.user_id, airlines: routine.airlines, origin: routine.origin, destination: routine.destination }
        await this.checkStale(routine.id, routine.priority, ctx)
        log.warn({ ...ctx, status: 'skipped' }, 'end_of_period skipped — no best fares found')
        continue
      }

      const retByAirline = Object.fromEntries(bestRet.map((b) => [b.airline, b]))
      const qualifying: QualifyingAirline[] = bestOut.map((out) => ({
        outbound: out,
        return: retByAirline[out.airline] ?? null,
      }))

      await this.dispatch(routine, qualifying, 'end_of_period')
    }
  }

  async sendDailyBest(): Promise<void> {
    const routines = await this.routinesRepo.findActiveForDailyBest()
    log.info({ routineCount: routines.length }, 'processing daily best notifications')

    const byUser = new Map<string, RoutineRow[]>()
    for (const r of routines) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
      byUser.get(r.user_id)!.push(r)
    }

    for (const [userId, userRoutines] of byUser) {
      const owner = await this.usersRepo.findById(userId)
      if (!owner) {
        log.warn({ userId }, 'daily_best skipped — user not found')
        continue
      }

      const sections: DailyBestRoutineSection[] = []
      const logEntries: Array<{ routine: RoutineRow; qualifying: QualifyingAirline[] }> = []

      for (const routine of userRoutines) {
        const [bestOut, bestRet] = await Promise.all([
          this.bestFaresRepo.getBestPerAirline(routine.id, false, routine.priority),
          routine.return_start
            ? this.bestFaresRepo.getBestPerAirline(routine.id, true, routine.priority)
            : Promise.resolve([]),
        ])

        if (bestOut.length === 0) {
          await this.checkStale(routine.id, routine.priority, { routineId: routine.id, userId })
          log.warn({ routineId: routine.id, userId, status: 'skipped' }, 'daily_best routine skipped — no best fares found')
          continue
        }

        const retByAirline = Object.fromEntries(bestRet.map((b) => [b.airline, b]))
        const qualifying: QualifyingAirline[] = bestOut.map((out) => ({
          outbound: out,
          return: retByAirline[out.airline] ?? null,
        }))

        const unsubToken = await this.unsubTokensRepo.create(routine.id, owner.email, true)

        sections.push({
          routineName:  routine.name,
          origin:       routine.origin,
          destination:  routine.destination,
          passengers:   routine.passengers,
          fareType:     routine.priority,
          airlineOffers: qualifying.map((q) => ({
            airline:  q.outbound.offer.airline,
            currency: q.outbound.currency,
            outbound: this.toBlock(q.outbound),
            return:   q.return ? this.toBlock(q.return) : null,
          })),
          unsubLink: `${this.env.API_BASE_URL}/unsubscribe/${unsubToken}`,
        })

        logEntries.push({ routine, qualifying })
      }

      if (sections.length === 0) {
        log.info({ userId, status: 'skipped' }, 'daily_best skipped — no routines with available fares')
        continue
      }

      await this.emailSvc.sendDailyBest({ primaryEmail: owner.email, routines: sections })

      for (const { routine, qualifying } of logEntries) {
        for (const q of qualifying) {
          const airline = q.outbound.offer.airline
          log.info({
            routineId:      routine.id,
            userId,
            routineName:    routine.name,
            airline,
            type:           'best_of_day',
            outboundAmount: q.outbound.amount,
            returnAmount:   q.return?.amount ?? null,
            status:         'success',
          }, 'daily_best notification dispatched')

          await this.notifLogRepo.insert({
            routineId:      routine.id,
            airline,
            type:           'best_of_day',
            fareType:       routine.priority,
            outboundAmount: q.outbound.amount,
            returnAmount:   q.return?.amount ?? null,
            emailTo:        owner.email,
            emailCc:        null,
          })
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async checkStale(routineId: string, fareType: string, ctx: object): Promise<void> {
    const stale = await this.bestFaresRepo.hasStaleData(routineId, fareType)
    if (stale) {
      log.error({ ...ctx, routineId, fareType, status: 'stale' }, 'routine fare data not updated in 4+ hours')
    }
  }

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
    qualifying: QualifyingAirline[],
    type: AlertType,
  ): Promise<void> {
    const owner = await this.usersRepo.findById(routine.user_id)
    if (!owner) {
      log.warn({ routineId: routine.id, userId: routine.user_id, airlines: routine.airlines, type, status: 'error' }, 'dispatch skipped — user not found')
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

    const airlineOffers: AirlineOfferPair[] = qualifying.map((q) => ({
      airline:  q.outbound.offer.airline,
      currency: q.outbound.currency,
      outbound: this.toBlock(q.outbound),
      return:   q.return ? this.toBlock(q.return) : null,
    }))

    await this.emailSvc.sendFlightAlert({
      primaryEmail:     owner.email,
      primaryUnsubLink: `${this.env.API_BASE_URL}/unsubscribe/${primaryToken}`,
      ccRecipients:     ccTokens,
      subject:          labels[type],
      routineName:      routine.name,
      origin:           routine.origin,
      destination:      routine.destination,
      airlineOffers,
      passengers:       routine.passengers,
      fareType:         routine.priority,
    })

    for (const q of qualifying) {
      const airline = q.outbound.offer.airline
      log.info({
        routineId:      routine.id,
        userId:         owner.id,
        routineName:    routine.name,
        airline,
        origin:         routine.origin,
        destination:    routine.destination,
        type,
        priority:       routine.priority,
        outboundAmount: q.outbound.amount,
        returnAmount:   q.return?.amount ?? null,
        currency:       q.outbound.currency,
        emailTo:        owner.email,
        ccCount:        activeCc.length,
        status:         'success',
      }, 'notification dispatched')

      await this.notifLogRepo.insert({
        routineId:      routine.id,
        airline,
        type,
        fareType:       routine.priority,
        outboundAmount: q.outbound.amount,
        returnAmount:   q.return?.amount ?? null,
        emailTo:        owner.email,
        emailCc:        activeCc.map((c) => c.email).join(',') || null,
      })
    }
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
