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

export interface IFareHistoryRepository {
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
