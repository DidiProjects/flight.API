export interface FlightFareRow {
  id: string
  scraping_job_id: string
  request_id: string
  flight_number: string | null
  flight_date: string
  is_return: boolean
  origin: string
  destination: string
  airline: string
  departure_time: string | null
  arrival_time: string | null
  duration_min: number | null
  stops: number | null
  currency: string | null
  fare_cash: number | null
  fare_pts: number | null
  fare_hyb_pts: number | null
  fare_hyb_cash: number | null
  /**
   * Value in Real FROZEN at collection time (017).
   *
   * Converting on read made the 30-day baseline move with the rate of the day and
   * hit the exchange API on every history open. `null` when there was no
   * trustworthy quote at the time — the row exists, it just does not enter
   * sums in Real.
   */
  fare_cash_brl: number | null
  fare_hyb_cash_brl: number | null
  /** How many BRL 1 unit of `currency` was worth at collection. 1 if already Real. */
  fx_rate: number | null
  /** Date of the QUOTE used, not of the collection. */
  fx_rate_date: string | null
  /** Pair the fare came from. NULL = collected in a loose one-way search. */
  return_date: string | null
  /**
   * OUTBOUND flight in whose context this return was priced. NULL on the outbound
   * and on any one-way fare. It is the 1-to-N link.
   */
  paired_outbound_flight: string | null
  /**
   * Outbound only: its returns exist but a known limitation hides them (TudoAzul
   * login on points). Pair displayed without a total, and no alert.
   */
  inbound_unavailable: boolean
  scraped_at: Date
}

export interface LatestFaresByDate {
  airline: string
  flight_date: string
  is_return: boolean
  departure_time: string | null
  arrival_time: string | null
  duration_min: number | null
  stops: number | null
  currency: string | null
  fare_cash: number | null
  fare_pts: number | null
  fare_hyb_pts: number | null
  fare_hyb_cash: number | null
  scraped_at: Date
}

export interface PriceHistory {
  currency: string | null
  avg_cash_30d: number | null
  min_cash_30d: number | null
  p20_cash_30d: number | null
  avg_pts_30d: number | null
  min_pts_30d: number | null
}

export interface CurrentBest {
  currency: string | null
  best_cash: number | null
  best_pts: number | null
  best_hyb_pts: number | null
  best_hyb_cash: number | null
  scraped_at: Date | null
  /**
   * Round-trip with no total because the return is undefined (a known airline
   * limitation). Tells "the trip has no total" from "nothing was collected" — the
   * outbound exists, it is just not the price of the trip.
   */
  inbound_unavailable?: boolean
  /**
   * Parts of the best pair, to display the total split into outbound and return.
   *
   * Each dimension brings the parts of ITS winning combination — the cheapest pair
   * in cash is not necessarily the cheapest in points.
   *
   * They are null when the total came from the airline bundle (single price, no
   * published split) and on a one-way routine, which has no pair.
   */
  best_cash_outbound?: number | null
  best_cash_inbound?: number | null
  best_pts_outbound?: number | null
  best_pts_inbound?: number | null
  best_hyb_pts_outbound?: number | null
  best_hyb_pts_inbound?: number | null
  best_hyb_cash_outbound?: number | null
  best_hyb_cash_inbound?: number | null
}

export interface PriceByDate {
  flight_date: string
  best_cash: number | null
  best_pts: number | null
  best_hyb_pts: number | null
  best_hyb_cash: number | null
}

/** Balance of a routine-scoped delete: what went, and what stayed because another routine sees it. */
export interface DeleteFaresResult {
  deleted: number
  /** Outbound rows of this routine that another routine also covers. */
  shared: number
}

export interface IFlightFaresRepository {
  insertMany(jobId: string, requestId: string, fares: Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'request_id' | 'scraped_at'>[]): Promise<number>
  getLatestByRoute(airline: string, origin: string, destination: string, dateFrom: string, dateTo: string, returnDate: string | null, maxAgeHours?: number): Promise<LatestFaresByDate[]>
  getLatestPairs(airline: string, origin: string, destination: string, outFrom: string, outTo: string, inFrom: string, inTo: string, maxAgeHours?: number): Promise<PairFareRow[]>
  getPriceHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory>
  /** With `inbound`, the baseline is the distribution of pair TOTALS; without, of loose fares. */
  getSummary(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceHistory>
  getCurrentBest(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<CurrentBest>
  /** With `inbound`, each OUTBOUND date carries the lowest pair total of that day. */
  getPriceByDate(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceByDate[]>
  /** Currency already seen on fares collected for the route/airlines (primary source for the routine). */
  getKnownCurrency(airlines: string[], origin: string, destination: string): Promise<string | null>
  aggregateToDailyBucket(bucketDate: string): Promise<number>
  cleanupOlderThan(days: number): Promise<number>
  /**
   * Drops the collections that ONLY this routine reaches, run by run.
   *
   * The card price comes straight from `flight_fares`, so a reset that leaves
   * the fares in place clears the history and keeps showing the old best price.
   */
  deleteExclusiveToRoutine(routineId: string): Promise<DeleteFaresResult>
}

/** A fare row collected in a PAIR (round-trip) search. */
export interface PairFareRow extends LatestFaresByDate {
  return_date: string
  origin: string
  destination: string
  /** Run that collected the pair. It is the pair identity: both legs share it. */
  request_id: string
  /**
   * OUTBOUND date of the pair. Comes from the outbound leg — the return has
   * `flight_date` equal to its own date, so `flight_date` cannot group the pair.
   */
  pair_outbound_date: string
  flight_number: string | null
  /** Outbound that priced this return. NULL on the outbound (and on older collections). */
  paired_outbound_flight: string | null
  /** Outbound only: return undefined by a known limitation (not a corrupted pair). */
  inbound_unavailable: boolean
  bundle_cash: string | number | null
  bundle_pts: string | number | null
  bundle_hyb_pts: string | number | null
  bundle_hyb_cash: string | number | null
}
