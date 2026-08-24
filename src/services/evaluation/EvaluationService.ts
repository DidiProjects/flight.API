import { IEvaluationService } from './interfaces/IEvaluationService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate, PairFareRow } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import {
  ITargetAlertStateRepository,
  PriceBreakdown,
} from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { IFxRateService } from '../fx/interfaces/IFxRateService'
import { AlertTotal } from '../email/interfaces/IEmailService'
import { RoutineRow } from '../../types'
import { logger } from '../../utils/logger'
import { isValidRoundTripPair } from '../../utils/roundtrip'
import { IncompleteRoundTripError } from '../../utils/errors'
import { isCheaperBy, sumMoney } from '../../utils/money'
// Fares older than this are stale and raise no alert. Shared with the card and
// the calendar: what is too old to alert on is too old to show as the current
// price. Well above the longest re-scraping interval, so a legitimate alert is
// never suppressed.
import { MAX_FARE_AGE_HOURS } from '../../config/fares'

const log = logger.child({ service: 'evaluation' })

/** The winning pair of an outbound date, with the original composition of both legs. */
interface PairChoice {
  outbound: LatestFaresByDate
  inbound: LatestFaresByDate
  total: number
  breakdown: PriceBreakdown[]
  /** Was either leg converted, and at what rate. */
  converted: boolean
  rateDate: string | null
}

/**
 * A fare ready to compare.
 *
 * `value` is in the target unit: BRL on a `cash` routine (converted when the
 * airline charged in another currency), points on `pts` and `hyb`. `breakdown`
 * holds what the airline REALLY charged, in its own currency — that is what the
 * watermark uses to tell a price change from an exchange rate change.
 */
interface Comparable {
  value: number
  /** Only on `hyb`: the cash part, already in BRL. */
  hybCashBrl: number | null
  breakdown: PriceBreakdown
  /** Was there a conversion, and at what rate? The e-mail has to say so. */
  converted: boolean
  rateDate: string | null
}

/** What steps 1-2 hand to the alert: one entry per outbound date within target. */
interface TargetOffers {
  bestByDate: Map<string, LatestFaresByDate>
  inboundByDate: Map<string, LatestFaresByDate> | undefined
  amountByDate: Map<string, number>
  breakdownByDate: Map<string, PriceBreakdown[]>
  totalsByDate: Map<string, AlertTotal> | undefined
}

function toDateStr(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

export { toDateStr }

export class EvaluationService implements IEvaluationService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly alertStateRepo: ITargetAlertStateRepository,
    private readonly notifSvc: INotificationsService,
    private readonly fx: IFxRateService,
    /**
     * How much cheaper a fare has to be before it is worth another e-mail: 1%.
     *
     * It serves two purposes at once. A price drop of a cent is not news, and a
     * composition that shifted by a hair because the exchange rate moved is not
     * a drop at all — an identical composition already blocks the common case,
     * and this is the net under it.
     */
    private readonly minImprovement = 0.01,
  ) {}

  async runCycle(): Promise<void> {
    let routines: RoutineRow[]
    try {
      routines = await this.routinesRepo.findAllActive()
    } catch (err) {
      log.error({ err }, 'evaluation cycle: failed to fetch active routines')
      return
    }

    for (const routine of routines) {
      try {
        await this.evaluateRoutine(routine)
      } catch (err) {
        log.error({ err, routineId: routine.id }, 'evaluation cycle error')
      }
    }
  }

  async cleanupAlertState(): Promise<number> {
    return this.alertStateRepo.cleanupPastDates()
  }

  /**
   * Re-sends the routine's target alert with the data that is in the bank right
   * now, skipping steps 3-6 — the whole point of asking for a resend is to
   * repeat what the anti-repetition would suppress.
   *
   * It deliberately does NOT touch target_alert_state: a diagnostic resend that
   * moved the watermark would change which alerts fire later, and the operator
   * asking for a copy of an e-mail is not asking for that.
   */
  async resendAlert(routine: RoutineRow): Promise<boolean> {
    const offers = await this.offersInTarget(routine)
    if (!offers) return false

    const { bestByDate, inboundByDate, amountByDate, totalsByDate } = offers

    // Same ordering as the cycle: cheapest first, ties broken by the most
    // recently scraped fare — so the headline here is the headline there.
    const sorted = [...bestByDate.entries()]
      .map(([flightDate, fare]) => ({ flightDate, fare, amount: amountByDate.get(flightDate)! }))
      .sort((a, b) =>
        a.amount - b.amount ||
        new Date(b.fare.scraped_at).getTime() - new Date(a.fare.scraped_at).getTime(),
      )
    if (sorted.length === 0) return false

    const headline = sorted[0]
    const history = await this.flightFaresRepo.getPriceHistory(
      headline.fare.airline,
      routine.origin,
      routine.destination,
      headline.flightDate,
    )

    const fares = sorted.map((o) => o.fare)
    if (inboundByDate) await this.notifSvc.dispatchAlert(routine, fares, history, inboundByDate, totalsByDate)
    else await this.notifSvc.dispatchAlert(routine, fares, history)

    log.info({
      routineId:   routine.id,
      routineName: routine.name,
      dates:       sorted.map((o) => o.flightDate),
      type:        'alert',
      trigger:     'manual-resend',
      status:      'success',
    }, 'alert resent by admin')

    return true
  }

  /**
   * Steps 1-2 of the cycle: the best offer WITHIN TARGET per outbound date. On a
   * round trip the date's offer is the pair (outbound + inbound) and the target
   * is compared against the total. `null` when nothing is within target.
   *
   * It lives apart because the manual resend needs exactly this and nothing that
   * follows: steps 3-6 are the anti-repetition, and a resend is precisely a
   * request to repeat.
   */
  private async offersInTarget(routine: RoutineRow): Promise<TargetOffers | null> {
    // 1-2. Best offer within target per outbound date. On round_trip the offer of
    //      the date is the PAIR (outbound + inbound) and target compares to the total.
    let inboundByDate: Map<string, LatestFaresByDate> | undefined
    let bestByDate: Map<string, LatestFaresByDate>
    // Original composition of each date price — what the airline charged, with no
    // conversion. It is what tells a real drop from a moved exchange rate.
    let breakdownByDate: Map<string, PriceBreakdown[]>
    // What the date is worth to the alert: the leg (one-way) or the pair total (RT).
    let amountByDate: Map<string, number>
    // Round_trip only: the total already converted, so the e-mail adds no currencies.
    let totalsByDate: Map<string, AlertTotal> | undefined

    if (routine.trip_type === 'round_trip') {
      const pairs = await this.bestPairsByOutboundDate(routine)
      if (pairs.size === 0) return null
      bestByDate      = new Map([...pairs].map(([date, p]) => [date, p.outbound]))
      inboundByDate   = new Map([...pairs].map(([date, p]) => [date, p.inbound]))
      amountByDate    = new Map([...pairs].map(([date, p]) => [date, p.total]))
      breakdownByDate = new Map([...pairs].map(([date, p]) => [date, p.breakdown]))
      // The pair total, ready for the e-mail: summing happens here, after
      // converting. Summing further down would add pounds to euros.
      totalsByDate = new Map([...pairs].map(([date, p]) => [date, {
        amount: p.total,
        currency: routine.priority === 'cash' ? 'BRL' : 'PTS',
        converted: p.converted,
        rateDate: p.rateDate,
      }]))
    } else {
      const allOutbound: LatestFaresByDate[] = []
      for (const airline of routine.airlines) {
        const outbound = await this.flightFaresRepo.getLatestByRoute(
          airline,
          routine.origin,
          routine.destination,
          toDateStr(routine.outbound_start),
          toDateStr(routine.outbound_end),
          // A one-way routine only sees loose fares. A fare collected in a
          // round-trip search is a pair price and does not count as one-way.
          null,
          MAX_FARE_AGE_HOURS,
        )
        allOutbound.push(...outbound)
      }
      if (allOutbound.length === 0) return null

      const chosen = await this.bestInTargetByDate(allOutbound, routine)
      bestByDate     = new Map([...chosen].map(([date, c]) => [date, c.fare]))
      amountByDate   = new Map([...chosen].map(([date, c]) => [date, c.cmp.value]))
      breakdownByDate = new Map([...chosen].map(([date, c]) => [date, [c.cmp.breakdown]]))
    }
    if (bestByDate.size === 0) return null


    return { bestByDate, inboundByDate, amountByDate, breakdownByDate, totalsByDate }
  }

  private async evaluateRoutine(routine: RoutineRow): Promise<void> {
    // Only routines on 'target' mode alert.
    if (!routine.notification_modes.includes('target')) return

    const offersFound = await this.offersInTarget(routine)
    if (!offersFound) return
    const { bestByDate, inboundByDate, amountByDate, breakdownByDate, totalsByDate } = offersFound

    // 3. Compare each date with its watermark (best price already alerted for it).
    const fareType = routine.priority
    const watermarks = await this.alertStateRepo.getWatermarks(routine.id, fareType)

    // Price floor of the routine: the lowest value ever alerted on ANY date. New
    // dates entering target at or above that floor are still recorded (per-date
    // watermark intact) but send NO e-mail — we only notify when the routine
    // breaks its own record.
    const routineFloor = watermarks.size
      ? Math.min(...[...watermarks.values()].map((w) => w.amount))
      : Infinity

    const candidates: { flightDate: string; amount: number; fare: LatestFaresByDate; breakdown: PriceBreakdown[] }[] = []
    for (const [date, fare] of bestByDate) {
      const amount = amountByDate.get(date)!
      const breakdown = breakdownByDate.get(date)!
      const prev = watermarks.get(date)

      // First offer within target for the date: always a candidate.
      if (prev == null) {
        candidates.push({ flightDate: date, amount, fare, breakdown })
        continue
      }

      // The airline charges exactly the same, in the same currencies: what moved
      // was the rate. That is not a price drop and cannot lower the watermark.
      if (this.sameBreakdown(prev.breakdown, breakdown)) continue

      // Different composition: compare in Real, in cents, and only past the
      // margin — the watermark came from NUMERIC(12,2) and a total computed here
      // never matches it bit for bit.
      if (isCheaperBy(amount, prev.amount, this.minImprovement)) {
        candidates.push({ flightDate: date, amount, fare, breakdown })
      }
    }
    if (candidates.length === 0) return

    // 4. Atomic monotonic upsert → only the dates the database confirmed as
    //    advanced (race-proof across overlapping cycles, no time-based cooldown).
    const advanced = await this.alertStateRepo.recordNotified(
      routine.id,
      fareType,
      candidates.map((c) => ({
        flightDate: c.flightDate, amount: c.amount, airline: c.fare.airline, breakdown: c.breakdown,
      })),
    )
    if (advanced.size === 0) return

    // 5. Offers of the dates that advanced, cheapest first. Price ties break by
    //    the most recently scraped fare (scraped_at). That is the SAME criterion
    //    dispatchAlert uses to pick the headline, so offers[0] is provably the
    //    fare the e-mail renders — and history (step 7) is computed for it, with
    //    no divergence between card and note.
    const offers = candidates
      .filter((c) => advanced.has(c.flightDate))
      .sort((a, b) =>
        a.amount - b.amount ||
        new Date(b.fare.scraped_at).getTime() - new Date(a.fare.scraped_at).getTime(),
      )
    if (offers.length === 0) return

    // 6. Per-routine record gate. The dates that advanced are already written to
    //    the per-date watermark (step 4, history intact), but the e-mail only
    //    goes out if the cheapest offer beats the routine floor BY THE MARGIN.
    //    That stops new dates at the same price from stacking one e-mail per
    //    cycle — measured on 2026-08-23, nine e-mails with the identical price,
    //    because the bare `>=` compared a total summed here against a floor that
    //    had been through NUMERIC(12,2) and lost by 4.5e-13.
    const headline = offers[0]
    if (!isCheaperBy(headline.amount, routineFloor, this.minImprovement)) {
      log.info({
        routineId:      routine.id,
        routineName:    routine.name,
        headlineAmount: headline.amount,
        routineFloor,
        minImprovement: this.minImprovement,
        advancedDates:  offers.map((o) => o.flightDate),
        type:           'alert',
        status:         'suppressed-not-record',
      }, 'evaluation: datas avançaram o watermark mas não bateram o recorde da rotina — e-mail suprimido')
      return
    }

    // 7. History (% below the 30d average) for the headline offer (the cheapest).
    const history = await this.flightFaresRepo.getPriceHistory(
      headline.fare.airline,
      routine.origin,
      routine.destination,
      headline.flightDate,
    )

    // One-way calls with the original signature (no 4th argument) so nothing
    // changes on the path that already existed.
    const fares = offers.map((o) => o.fare)
    if (inboundByDate) await this.notifSvc.dispatchAlert(routine, fares, history, inboundByDate, totalsByDate)
    else await this.notifSvc.dispatchAlert(routine, fares, history)
  }

  /**
   * Best (outbound, inbound) pair per outbound date, for round_trip routines.
   *
   * Product decisions (2026-07-24):
   *  · both legs on the SAME airline — only then is the RT discount identifiable;
   *  · a pair only counts with the SAME currency on both legs — no conversion;
   *  · inbound at most 3 months after the outbound (`isValidRoundTripPair`);
   *  · an airline that returned only one leg is discarded and reported.
   *
   * The watermark cell stays the OUTBOUND date: each outbound date carries the
   * best valid total it can close. The alert keeps one line per date and
   * `routineFloor` still holds with no schema change.
   */
  private async bestPairsByOutboundDate(
    routine: RoutineRow,
  ): Promise<Map<string, PairChoice>> {
    const best = new Map<string, PairChoice>()

    for (const airline of routine.airlines) {
      const rows = await this.flightFaresRepo.getLatestPairs(
        airline, routine.origin, routine.destination,
        toDateStr(routine.outbound_start), toDateStr(routine.outbound_end),
        toDateStr(routine.inbound_start!), toDateStr(routine.inbound_end!),
        MAX_FARE_AGE_HOURS,
      )
      if (rows.length === 0) continue

      // Group by RUN: both legs of the pair come from the same RT search and
      // share request_id. Grouping by flight_date split the legs into different
      // groups (the inbound carries ITS date) and every real pair fell through
      // as incomplete.
      const byPair = new Map<string, PairFareRow[]>()
      for (const r of rows) {
        const list = byPair.get(r.request_id)
        if (list) list.push(r)
        else byPair.set(r.request_id, [r])
      }

      for (const legs of byPair.values()) {
        const outDate = toDateStr(legs[0].pair_outbound_date)
        // Log only: identifies the pair in incomplete-pair messages.
        const key = `${outDate}|${toDateStr(legs[0].return_date)}`
        const outbound = legs.filter((l) => !l.is_return)
        const inbound = legs.filter((l) => l.is_return)

        // Inbound undefined by a known limitation: the return EXISTS, the airline
        // just will not show it (on points Azul requires a TudoAzul login). Not
        // corrupted data, so nothing is reported — but no total either: if the
        // return is unknown, the outbound price is not the trip price.
        if (inbound.length === 0 && outbound.length > 0 && outbound.every((o) => o.inbound_unavailable)) {
          log.info(
            { routineId: routine.id, airline, pair: key },
            'evaluation: volta indefinida (limitação conhecida) — par exibido sem total, sem alerta',
          )
          continue
        }

        // A pair that came back with one leg is corrupted data, not a cheap offer.
        if (outbound.length === 0 || inbound.length === 0) {
          const missingLeg = outbound.length === 0 ? 'outbound' : 'inbound'
          log.error(
            { err: new IncompleteRoundTripError(routine.id, airline, missingLeg), routineId: routine.id, airline, missingLeg, pair: key },
            'evaluation: par round-trip incompleto — par descartado do ciclo',
          )
          continue
        }

        // The "different currencies between legs" guard was removed: it existed
        // because there was no conversion, and it discarded exactly the legitimate
        // pair where the airline charges each leg in its own market. With both
        // legs in Real, the sum holds.

        for (const out of outbound) {
          const outCmp = await this.comparable(out, routine, 'outbound')
          if (outCmp == null) continue
          const outValue = outCmp.value

          // The inbounds of THIS outbound, and only those. An inbound was priced
          // IN THE CONTEXT of one outbound: crossing it with another would invent
          // a pair the airline never offered (and that is where the discount lives).
          const mine = this.inboundsFor(out, inbound)
          if (mine.length === 0) {
            // The pair has inbounds, but none for this outbound. If the limitation
            // is known, tolerate silently; otherwise it is corrupted data.
            if (out.inbound_unavailable) {
              log.info(
                { routineId: routine.id, airline, pair: key, outboundFlight: out.flight_number },
                'evaluation: ida com volta indefinida — sem total, sem alerta',
              )
            } else {
              log.error(
                { err: new IncompleteRoundTripError(routine.id, airline, 'inbound'), routineId: routine.id, airline, pair: key, outboundFlight: out.flight_number },
                'evaluation: ida sem nenhuma volta vinculada — ida descartada do ciclo',
              )
            }
            continue
          }

          for (const inb of mine) {
            const inCmp = await this.comparable(inb, routine, 'inbound')
            if (inCmp == null) continue
            const inValue = inCmp.value

            // Pair price: the airline bundle when it came, else the sum of the legs
            // from that same RT search. Never mixed with a loose fare.
            const bundle = this.bundleValue(out, routine)
            const total = bundle ?? sumMoney(outValue, inValue)
            if (!this.totalInTarget(total, routine, outCmp, inCmp)) continue

            const cur = best.get(outDate)
            if (cur == null || total < cur.total) {
              // Composition of the PAIR: both legs as the airline charged them.
              best.set(outDate, {
                outbound: out, inbound: inb, total,
                breakdown: [outCmp.breakdown, inCmp.breakdown],
                converted: outCmp.converted || inCmp.converted,
                rateDate:  outCmp.rateDate ?? inCmp.rateDate,
              })
            }
          }
        }
      }
    }

    return best
  }

  /**
   * Inbounds that belong to this outbound.
   *
   * The scraper stamps `paired_outbound_flight` on each inbound with the outbound
   * flight number that priced it. Collection older than that stamp has no link:
   * it falls back to the old behaviour (every inbound of the pair), otherwise the
   * fares already in the bank would stop being evaluated overnight.
   */
  private inboundsFor(out: PairFareRow, inbound: PairFareRow[]): PairFareRow[] {
    const linked = inbound.filter((i) => i.paired_outbound_flight != null)
    if (linked.length === 0) return inbound
    return linked.filter((i) => i.paired_outbound_flight === out.flight_number)
  }

  /** Pair total charged by the airline (bundle), in the price dimension of the routine. */
  private bundleValue(fare: PairFareRow, routine: RoutineRow): number | null {
    const raw =
      routine.priority === 'cash' ? fare.bundle_cash :
      routine.priority === 'pts'  ? fare.bundle_pts :
      routine.priority === 'hyb'  ? fare.bundle_hyb_pts :
      null
    return raw == null ? null : Number(raw)
  }

  /**
   * Pair target: on round_trip the user aims at the TRIP price, so the total of
   * both legs is compared against the target (with the same margin as one-way).
   * On hybrid both dimensions must fit once summed.
   */
  private totalInTarget(
    total: number,
    routine: RoutineRow,
    out: Comparable,
    inb: Comparable,
  ): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash') return routine.target_cash != null && total <= routine.target_cash * t
    if (routine.priority === 'pts')  return routine.target_pts != null && total <= routine.target_pts * t
    if (routine.priority === 'hyb') {
      if (routine.target_hyb_pts == null || routine.target_hyb_cash == null) return false
      // The cash parts already arrive in Real: adding pounds to euros would give
      // a number with no meaning.
      if (out.hybCashBrl == null || inb.hybCashBrl == null) return false
      const cashTotal = out.hybCashBrl + inb.hybCashBrl
      return total <= routine.target_hyb_pts * t && cashTotal <= routine.target_hyb_cash * t
    }
    return false
  }

  /**
   * Best fare within target per date.
   *
   * Collapses airlines — the user wants the best price of the date, the airline
   * is a detail of the e-mail. And since airlines on the same routine may charge
   * in different currencies, the minimum only makes sense after conversion:
   * comparing £730 with R$4,900 would pick the pound for being "smaller".
   */
  private async bestInTargetByDate(
    fares: LatestFaresByDate[],
    routine: RoutineRow,
  ): Promise<Map<string, { fare: LatestFaresByDate; cmp: Comparable }>> {
    const best = new Map<string, { fare: LatestFaresByDate; cmp: Comparable }>()
    for (const f of fares) {
      const cmp = await this.comparable(f, routine, 'outbound')
      if (cmp == null) continue
      if (!this.meetsTarget(cmp, routine)) continue
      const date = toDateStr(f.flight_date)
      const cur = best.get(date)
      if (cur == null || cmp.value < cur.cmp.value) best.set(date, { fare: f, cmp })
    }
    return best
  }

  /** Does the value (already in Real, when cash) fit the routine target? */
  private meetsTarget(cmp: Comparable, routine: RoutineRow): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash') return routine.target_cash != null && cmp.value <= routine.target_cash * t
    if (routine.priority === 'pts')  return routine.target_pts != null && cmp.value <= routine.target_pts * t
    if (routine.priority === 'hyb') {
      if (routine.target_hyb_pts == null || routine.target_hyb_cash == null) return false
      if (cmp.hybCashBrl == null) return false
      return cmp.value <= routine.target_hyb_pts * t && cmp.hybCashBrl <= routine.target_hyb_cash * t
    }
    return false
  }

  private fareValue(fare: LatestFaresByDate, routine: RoutineRow): number | null {
    // NUMERIC comes back from pg as a string — coerce to Number, otherwise the
    // comparison turns lexicographic ("1076.00" < "652.00" === true).
    const raw =
      routine.priority === 'cash' ? fare.fare_cash :
      routine.priority === 'pts'  ? fare.fare_pts :
      routine.priority === 'hyb'  ? fare.fare_hyb_pts :
      null
    return raw == null ? null : Number(raw)
  }

  /**
   * The fare ready to compare, with cash already in Real.
   *
   * The routine target is always in Real; the airline charges in the currency of
   * its market. Without this conversion, £730 would be compared against a target
   * of R$5,000 and pass as a bargain.
   *
   * Points do NOT convert: `PTS` is a loyalty programme unit, not a currency.
   *
   * `null` when there is no trustworthy rate — the pair leaves the cycle and
   * returns next time. Alerting on a doubtful number is the one unacceptable outcome.
   */
  private async comparable(
    fare: LatestFaresByDate,
    routine: RoutineRow,
    direction: PriceBreakdown['direction'],
  ): Promise<Comparable | null> {
    const raw = this.fareValue(fare, routine)
    if (raw == null) return null

    const currency = fare.currency ?? null
    // The composition holds what the airline charged, unconverted: it is the
    // fingerprint of the price from one cycle to the next.
    const breakdown: PriceBreakdown = { direction, currency: currency ?? 'PTS', amount: raw }

    if (routine.priority === 'pts') {
      return { value: raw, hybCashBrl: null, breakdown, converted: false, rateDate: null }
    }

    if (routine.priority === 'cash') {
      if (currency == null) return null
      const conv = await this.fx.toBrl(raw, currency)
      if (conv == null) {
        log.warn({ routineId: routine.id, currency }, 'evaluation: sem cotação — tarifa fora do ciclo')
        return null
      }
      return {
        value: conv.amount, hybCashBrl: null, breakdown,
        converted: conv.source !== 'native', rateDate: conv.rateDate,
      }
    }

    // hyb: the compared dimension is points; the cash part also becomes Real.
    if (fare.fare_hyb_cash == null || currency == null) return null
    const conv = await this.fx.toBrl(Number(fare.fare_hyb_cash), currency)
    if (conv == null) {
      log.warn({ routineId: routine.id, currency }, 'evaluation: sem cotação para a parte em dinheiro do híbrido')
      return null
    }
    return {
      value: raw, hybCashBrl: conv.amount, breakdown,
      converted: conv.source !== 'native', rateDate: conv.rateDate,
    }
  }

  /**
   * Did the price really change, or did the exchange rate just move?
   *
   * Identical composition = the airline charges exactly the same, in the same
   * currencies. Any difference in the converted value came from the rate, and
   * announcing that as a "new best price" would be a lie — besides lowering the
   * watermark and hiding the real drop that came later.
   */
  private sameBreakdown(a: PriceBreakdown[] | null, b: PriceBreakdown[]): boolean {
    if (a == null || a.length !== b.length) return false
    return b.every((leg, i) =>
      a[i]!.direction === leg.direction &&
      a[i]!.currency === leg.currency &&
      Number(a[i]!.amount) === Number(leg.amount))
  }
}
