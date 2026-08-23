import { CurrentBest, PriceByDate, PriceHistory } from './IFlightFaresRepository'

/** One flown SEGMENT: airport to airport. One per journey today. */
export interface Segment {
  origin: string
  destination: string
}

/**
 * What the airline SELLS and prices: the outbound, or the return.
 *
 * The money lives here — not on the segment — because that is how the fare is
 * quoted. `segments` has one element today; the day connections are modelled it
 * has N, and nothing in the contract has to change.
 */
export interface Journey {
  direction: 'outbound' | 'inbound'
  /** Currency of THIS journey, as the airline charged it. */
  currency: string | null
  cash: number | null
  pts: number | null
  hybPts: number | null
  hybCash: number | null
  segments: Segment[]
}

export type FlightFaresCurrent = PriceHistory & CurrentBest & {
  /**
   * The journeys of the best pair: one on one-way, two on round-trip.
   *
   * Replaces the eight flattened fields (`best_cash_outbound`, `best_pts_inbound`
   * …), which could not carry a currency per journey without becoming twelve. The
   * old ones stay in the payload until the front migrates.
   *
   * ⚠ Measured on 2026-08-04: the two journeys of a pair NEVER have different
   * currencies (196 rows, 11 runs, zero divergence). An RT search is priced in the
   * market of departure, and both legs come out together. A different currency
   * appears between distinct ROUTINES — the same leg collected by an RT search and
   * by a one-way leaving from the other side.
   */
  journeys: Journey[]
}

export interface IFlightFaresService {
  getHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory>
  getSummary(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceHistory>
  getCurrent(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<FlightFaresCurrent>
  getByDate(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceByDate[]>
}
