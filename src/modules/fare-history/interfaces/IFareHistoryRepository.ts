/**
 * Curated price history: the itinerary that is tracked and the segments its
 * price held.
 *
 * Separate from `IFlightFaresRepository` on purpose. That one owns `flight_fares`,
 * the raw collection purged at 30 days; this one owns the series that survives it
 * and answers "how did this fare behave over six months".
 */

/** A price segment: the window during which the itinerary held one price. */
export interface FarePricePoint {
  currency: string
  amountCash: number | null
  amountPts: number | null
  amountHybPts: number | null
  amountHybCash: number | null
  /** Real frozen at collection (017). Comparable across time; the raw amount is not. */
  amountCashBrl: number | null
  amountHybCashBrl: number | null
  observedFrom: Date
  lastSeenAt: Date
  /** Collections that confirmed this price. Separates a measured plateau from a single sighting. */
  observationCount: number
}

/** Window and resolution of a series. Fixed set: the SQL interval is not user input. */
export type FareHistoryRange = 'day' | 'month' | '6m'

/**
 * One bucket of the chart. `min_cash`/`min_pts` are the best price OFFERED during
 * the bucket — the minimum across every segment that overlaps it.
 *
 * `samples` is how many segments overlapped. Zero means nothing was on sale (or
 * nothing was collected) in that window: an honest hole, not a price of zero.
 * NUMERIC arrives from pg as string.
 */
export interface FareHistoryBucket {
  bucket_start: Date
  min_cash: string | null
  min_pts: string | null
  /** Hybrid keeps its two components: the points side is what the card charts. */
  min_hyb_pts: string | null
  min_hyb_cash: string | null
  samples: number
}

export interface FareHistorySeries {
  /** Currency of the most recent segment — the one the card is showing. */
  currency: string | null
  buckets: FareHistoryBucket[]
}

/** Route and windows of a routine. With `inbound`, the series is of pair TOTALS. */
export interface FareHistoryQuery {
  airlines: string[]
  origin: string
  destination: string
  dateFrom: string
  dateTo: string
  inbound?: { from: string; to: string }
}

export interface IFareHistoryRepository {
  /**
   * The best price over time for the routine's route and windows.
   *
   * Not the series of one itinerary: the cheapest itinerary changes, and what the
   * card shows is the best of the moment. Each bucket takes the minimum across
   * every segment that overlaps it, which is the same quantity the headline price
   * is — over time.
   */
  getSeries(query: FareHistoryQuery, range: FareHistoryRange): Promise<FareHistorySeries>

  /**
   * Derives the itineraries of a run from the fares it just wrote and records
   * the price of each.
   *
   * Reads back from `flight_fares` instead of taking the rows as an argument:
   * assembling the pair in TypeScript would be a second implementation of the
   * join that `getCurrentBestPair` already does in SQL, free to drift from it.
   *
   * Returns how many segments were OPENED — a run where nothing moved returns 0
   * and is not a failure.
   */
  recordRun(requestId: string): Promise<number>

  /**
   * Drops itineraries not seen for `days`, and their history with them
   * (ON DELETE CASCADE). An itinerary off the radar is a flight that no longer
   * sells; keeping its series would only grow the table.
   */
  cleanupNotSeenSince(days: number): Promise<number>
}
