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
  /** Par de origem da tarifa. NULL = colhida numa busca one-way avulsa. */
  return_date: string | null
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
}

export interface PriceByDate {
  flight_date: string
  best_cash: number | null
  best_pts: number | null
  best_hyb_pts: number | null
  best_hyb_cash: number | null
}

export interface IFlightFaresRepository {
  insertMany(jobId: string, requestId: string, fares: Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'request_id' | 'scraped_at'>[]): Promise<number>
  getLatestByRoute(airline: string, origin: string, destination: string, dateFrom: string, dateTo: string, returnDate: string | null, maxAgeHours?: number): Promise<LatestFaresByDate[]>
  getLatestPairs(airline: string, origin: string, destination: string, outFrom: string, outTo: string, inFrom: string, inTo: string, maxAgeHours?: number): Promise<PairFareRow[]>
  getPriceHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory>
  getSummary(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string): Promise<PriceHistory>
  getCurrentBest(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<CurrentBest>
  getPriceByDate(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string): Promise<PriceByDate[]>
  /** Moeda já observada em tarifas coletadas para o trajeto/companhias (fonte primária da rotina). */
  getKnownCurrency(airlines: string[], origin: string, destination: string): Promise<string | null>
  aggregateToDailyBucket(bucketDate: string): Promise<number>
  cleanupOlderThan(days: number): Promise<number>
}

/** Linha de tarifa colhida numa busca de PAR (ida-e-volta). */
export interface PairFareRow extends LatestFaresByDate {
  return_date: string
  origin: string
  destination: string
  bundle_cash: string | number | null
  bundle_pts: string | number | null
  bundle_hyb_pts: string | number | null
  bundle_hyb_cash: string | number | null
}
