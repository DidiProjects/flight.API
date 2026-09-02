import { RoutineRow } from '../../types'
import { INotificationsService } from './interfaces/INotificationsService'
import { INotificationLogRepository } from './interfaces/INotificationLogRepository'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate, PairFareRow, PriceHistory } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { IUnsubscribeTokensRepository } from '../../modules/unsubscribe/interfaces/IUnsubscribeTokensRepository'
import { IUsersRepository } from '../../modules/users/interfaces/IUsersRepository'
import { IEmailService, AirlineOfferPair, AlertTotal, DailyBestRoutineSection, OfferBlock } from '../email/interfaces/IEmailService'
import { IFxRateService } from '../fx/interfaces/IFxRateService'
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
    private readonly fx: IFxRateService,
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
        // Catch-up matches `<=` on the time, so we de-duplicate here: if a
        // 'scheduled' send already happened in the last 12h, do not resend (daily).
        if (await this.notifLogRepo.hasNotificationSinceHours(routine.id, 'scheduled', 12)) {
          continue
        }

        const built = await this.buildDailySection(routine, owner.email)
        if (!built) continue

        sections.push(built.section)
        logEntries.push({ routine, bestFare: built.bestFare })
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

  /**
   * Re-sends the daily summary for a single routine, with the fares that are in
   * the bank right now. Skips the 12h de-dup of the scheduled loop — asking for
   * a resend is asking to bypass exactly that. `false` when the routine has no
   * fare to show.
   */
  async resendDailySummary(routine: RoutineRow): Promise<boolean> {
    const owner = await this.usersRepo.findById(routine.user_id)
    if (!owner) {
      log.warn({ routineId: routine.id, userId: routine.user_id }, 'resend skipped — user not found')
      return false
    }

    const built = await this.buildDailySection(routine, owner.email)
    if (!built) return false

    await this.emailSvc.sendDailyBest({ primaryEmail: owner.email, routines: [built.section] })

    log.info({
      routineId:      routine.id,
      userId:         owner.id,
      routineName:    routine.name,
      airline:        built.bestFare.airline,
      type:           'scheduled',
      trigger:        'manual-resend',
      outboundAmount: this.fareAmount(built.bestFare, routine.priority),
      status:         'success',
    }, 'daily summary resent by admin')

    await this.notifLogRepo.insert({
      routineId:      routine.id,
      airline:        built.bestFare.airline,
      type:           'scheduled',
      fareType:       routine.priority,
      outboundAmount: this.fareAmount(built.bestFare, routine.priority),
      returnAmount:   null,
      emailTo:        owner.email,
      emailCc:        null,
    })

    return true
  }

  /**
   * The daily-summary block for one routine, or `null` when there is no fare to
   * show. Extracted from the scheduled loop so the manual resend can build the
   * very same block for a single routine.
   */
  private async buildDailySection(
    routine: RoutineRow,
    ownerEmail: string,
  ): Promise<{ section: DailyBestRoutineSection; bestFare: LatestFaresByDate } | null> {
      // Round-trip reads PAIRS; one-way reads loose fares. The two worlds do not
      // mix: showing the price of one leg as if it were the trip (or a pair price
      // as if it were loose) would be a lie in either case.
      const isRoundTrip = routine.trip_type === 'round_trip'
      const allOutbound: LatestFaresByDate[] = []
      let bestPairInbound: LatestFaresByDate | null = null
      let bestPairTotal: number | null = null

      if (isRoundTrip) {
        for (const airline of routine.airlines) {
          const rows = await this.flightFaresRepo.getLatestPairs(
            airline, routine.origin, routine.destination,
            toDateStr(routine.outbound_start), toDateStr(routine.outbound_end),
            toDateStr(routine.inbound_start!), toDateStr(routine.inbound_end!),
          )
          // Group by RUN: both legs of the pair come from the same RT search and share
          // request_id. Grouping by flight_date put them in DIFFERENT groups — the
          // inbound carries ITS own date (11-20|11-20 against the outbound's
          // 11-10|11-20) — so every group had one leg, `inb` was always null, and the
          // routine left the summary as "no fares found". The evaluation cycle fixed
          // this and the summary never received the fix.
          const byPair = new Map<string, PairFareRow[]>()
          for (const r of rows) {
            const list = byPair.get(r.request_id)
            if (list) list.push(r)
            else byPair.set(r.request_id, [r])
          }
          for (const legs of byPair.values()) {
            // Both legs converted BEFORE choosing the cheapest and before summing.
            // The pair whose outbound is charged in Real and whose return is charged
            // in pounds is the ordinary shape of a Brazil↔London routine, not corrupt
            // data — and it was being discarded whole.
            const out = await this.bestFareBrl(legs.filter((l) => !l.is_return), routine)
            const inb = await this.bestFareBrl(legs.filter((l) => l.is_return), routine)
            if (!out || !inb) continue

            const bundleRaw =
              routine.priority === 'cash' ? out.fare.bundle_cash :
              routine.priority === 'pts'  ? out.fare.bundle_pts :
              out.fare.bundle_hyb_pts
            const total = bundleRaw == null ? out.value + inb.value : Number(bundleRaw)

            if (bestPairTotal == null || total < bestPairTotal) {
              bestPairTotal = total
              bestPairInbound = inb.fare
              allOutbound.length = 0
              allOutbound.push(out.fare)
            }
          }
        }
      } else {
        for (const airline of routine.airlines) {
          const outbound = await this.flightFaresRepo.getLatestByRoute(
            airline,
            routine.origin,
            routine.destination,
            toDateStr(routine.outbound_start),
            toDateStr(routine.outbound_end),
            null,
          )
          allOutbound.push(...outbound)
        }
      }

      if (allOutbound.length === 0) {
        log.warn({ routineId: routine.id, userId: routine.user_id, status: 'skipped' }, 'scheduled routine skipped — no fares found')
        return null
      }

      const bestOutbound = this.bestFare(allOutbound, routine.priority)
      if (!bestOutbound) return null

      const unsubToken = await this.unsubTokensRepo.create(routine.id, ownerEmail, true)

      const section: DailyBestRoutineSection = {
        routineName:  routine.name,
        origin:       routine.origin,
        destination:  routine.destination,
        passengers:   routine.passengers,
        fareType:     routine.priority,
        airlineOffers: [{
          airline:  bestOutbound.airline,
          outbound: this.fareToBlock(bestOutbound, routine.origin, routine.destination),
          // The return is the inverted route.
          return:   bestPairInbound
            ? this.fareToBlock(bestPairInbound, routine.destination, routine.origin)
            : null,
          // The scheduled summary does not go through evaluation, so it has no
          // converted total. Without it the e-mail shows the legs and omits the sum
          // — which is right when the currencies may differ.
          total: null,
        }],
        unsubLink: `${this.env.API_BASE_URL}/unsubscribe/${unsubToken}`,
      }

      return { section, bestFare: bestOutbound }
  }


  async dispatchAlert(
    routine: RoutineRow,
    outboundFares: LatestFaresByDate[],
    history: PriceHistory,
    // Round-trip: the return leg that closes the pair of each outbound date. The
    // e-mail shows the headline pair; one-way passes nothing and the card is unchanged.
    inboundByOutboundDate?: Map<string, LatestFaresByDate>,
    totalsByDate?: Map<string, AlertTotal>,
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

    // Headline = cheapest offer; a price tie breaks by the most recently scraped
    // fare (scraped_at). The history (% below average) belongs to it.
    const headline = outboundFares.reduce((best, f) => {
      const fv = this.fareAmount(f, routine.priority) ?? Infinity
      const bv = this.fareAmount(best, routine.priority) ?? Infinity
      if (fv < bv) return f
      if (fv === bv && new Date(f.scraped_at).getTime() > new Date(best.scraped_at).getTime()) return f
      return best
    })
    const historyNote = this.buildHistoryNote(headline, history, routine.priority)

    // Only ONE fare per routine in the e-mail: the headline. The other dates that
    // advanced were already written to the watermark (target_alert_state) by
    // EvaluationService — they are simply not displayed here.
    const inboundOfHeadline = inboundByOutboundDate?.get(toDateStr(headline.flight_date)) ?? null

    const airlineOffers: AirlineOfferPair[] = [{
      airline:  headline.airline,
      outbound: this.fareToBlock(headline, routine.origin, routine.destination),
      // The return is the inverted route.
      return:   inboundOfHeadline
        ? this.fareToBlock(inboundOfHeadline, routine.destination, routine.origin)
        : null,
      // The total comes READY from evaluation — it is the number that fired the
      // alert. Recomputing it here by summing the legs would add pounds to euros.
      total: inboundOfHeadline ? (totalsByDate?.get(toDateStr(headline.flight_date)) ?? null) : null,
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

  /**
   * Cheapest leg, compared in Real.
   *
   * `bestFare` picks by the raw amount the airline charged, which only holds while
   * every leg is in the same currency: £730 beats R$4,900 for being the smaller
   * number. On a round trip the summary now sees both markets, so the choice — and
   * the sum that follows — happen after conversion.
   *
   * Points do not convert: `PTS` is a loyalty unit, not a currency. `null` when
   * there is no trustworthy rate, the same rule the evaluation cycle applies —
   * a summary built on a doubtful number is worse than a summary without the line.
   */
  private async bestFareBrl<T extends LatestFaresByDate>(
    fares: T[],
    routine: RoutineRow,
  ): Promise<{ fare: T; value: number } | null> {
    let best: { fare: T; value: number } | null = null

    for (const fare of fares) {
      const raw = this.fareAmount(fare, routine.priority)
      if (raw == null) continue

      let value = raw
      if (routine.priority === 'cash') {
        if (fare.currency == null) continue
        const conv = await this.fx.toBrl(raw, fare.currency)
        if (conv == null) {
          log.warn({ routineId: routine.id, currency: fare.currency }, 'resumo: sem cotação — perna fora do resumo')
          continue
        }
        value = conv.amount
      }

      if (best == null || value < best.value) best = { fare, value }
    }

    return best
  }

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
      // The currency belongs to the LEG. Inheriting it from the pair is what made a
      // return in Real show up labelled in pounds.
      currency:      fare.currency ?? '',
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
    // NUMERIC comes back from pg as a string — coerce to Number, otherwise the
    // bestFare comparison turns lexicographic ("1076.00" < "652.00" === true).
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
