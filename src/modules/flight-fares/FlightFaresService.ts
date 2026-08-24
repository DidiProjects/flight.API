import { FlightFaresCurrent, IFlightFaresService, Journey } from './interfaces/IFlightFaresService'
import { CurrentBest, IFlightFaresRepository, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

/**
 * Reading fares with NO network.
 *
 * Exchange left this file in 017: converting on read hit the API on every history
 * open and made the 30-day baseline move with the rate of the day. Conversion
 * moved to analysis ingestion, with the rate stored on the row.
 */
export class FlightFaresService implements IFlightFaresService {
  constructor(private readonly repo: IFlightFaresRepository) {}

  getHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory> {
    return this.repo.getPriceHistory(airline, origin, destination, flightDate)
  }

  getSummary(
    airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string,
    // Round_trip routine: the baseline is the distribution of PAIR totals, else
    // the verdict compares two legs against the average of one.
    inbound?: { from: string; to: string },
  ): Promise<PriceHistory> {
    return this.repo.getSummary(airlines, origin, destination, dateFrom, dateTo, inbound)
  }

  async getCurrent(
    airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string,
    // Round_trip routine: the current price is the pair TOTAL, not the outbound leg.
    inbound?: { from: string; to: string },
  ): Promise<FlightFaresCurrent> {
    // The baseline follows the value: with `inbound`, both are pair-level.
    const [current, summary] = await Promise.all([
      this.repo.getCurrentBest(airlines, origin, destination, dateFrom, dateTo, inbound),
      this.repo.getSummary(airlines, origin, destination, dateFrom, dateTo, inbound),
    ])
    // The pair total already comes summed in Real from the SQL (017): conversion
    // happens once, at analysis ingestion, with the rate stored on the row. It used
    // to be here, on every screen open, and the value moved with the daily rate.
    //
    // The coercion is still needed: NUMERIC comes back from pg as a STRING, and it
    // was `pairTotal` that did it while summing. Without it the total leaves the
    // JSON as "12548.00" and any comparison on the front turns lexicographic.
    return {
      ...summary,
      ...current,
      best_cash:     this.num(current.best_cash),
      best_pts:      this.num(current.best_pts),
      best_hyb_pts:  this.num(current.best_hyb_pts),
      best_hyb_cash: this.num(current.best_hyb_cash),
      journeys: this.toJourneys(current, origin, destination, inbound),
    }
  }

  /**
   * The journeys of the best pair, from the parts the query already returns.
   *
   * Both carry BRL: every money figure the dashboard reads is now the Real frozen
   * at collection (017), pair and one-way alike. The field stays per journey so the
   * front never inherits a currency from a level above — that is how outbound and
   * return came out labelled the same, and how a Real number ended up wearing the
   * pound sign of the chart series next to it.
   */
  /**
   * NUMERIC comes back from pg as a STRING.
   *
   * Without coercing, `out.cash + in.cash` becomes concatenation ("4921.00" +
   * "7627.00" = "4921.007627.00"), Math.round of that is NaN and JSON serialises
   * NaN as null — the total simply vanished from the card. The project already
   * tripped on this in price comparison, which turned lexicographic.
   */
  private num(v: unknown): number | null {
    if (v == null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  private toJourneys(
    c: CurrentBest,
    origin: string,
    destination: string,
    inbound?: { from: string; to: string },
  ): Journey[] {
    const outbound: Journey = {
      direction: 'outbound',
      currency:  c.currency,
      cash:      this.num(inbound ? c.best_cash_outbound     : c.best_cash),
      pts:       this.num(inbound ? c.best_pts_outbound      : c.best_pts),
      hybPts:    this.num(inbound ? c.best_hyb_pts_outbound  : c.best_hyb_pts),
      hybCash:   this.num(inbound ? c.best_hyb_cash_outbound : c.best_hyb_cash),
      segments:  [{ origin, destination }],
    }
    if (!inbound) return [outbound]

    return [outbound, {
      direction: 'inbound',
      currency:  c.currency,
      cash:      this.num(c.best_cash_inbound),
      pts:       this.num(c.best_pts_inbound),
      hybPts:    this.num(c.best_hyb_pts_inbound),
      hybCash:   this.num(c.best_hyb_cash_inbound),
      // The return is the INVERTED ROUTE. `inbound.from/to` are the DATE window of
      // the return, not airports — using them here put "2026-09-25" in place of the
      // IATA code, and it only showed up when calling the real API.
      segments:  [{ origin: destination, destination: origin }],
    }]
  }

  getByDate(
    airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string,
    inbound?: { from: string; to: string },
  ): Promise<PriceByDate[]> {
    return this.repo.getPriceByDate(airlines, origin, destination, dateFrom, dateTo, inbound)
  }
}
