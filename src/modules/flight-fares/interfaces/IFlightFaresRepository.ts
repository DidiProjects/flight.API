export interface FlightFareRow {
  id: string
  scraping_job_id: string
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
  fare_cash: number | null
  fare_pts: number | null
  fare_hyb_pts: number | null
  fare_hyb_cash: number | null
  scraped_at: Date
}

export interface LatestFaresByDate {
  flight_date: string
  is_return: boolean
  departure_time: string | null
  arrival_time: string | null
  duration_min: number | null
  stops: number | null
  fare_cash: number | null
  fare_pts: number | null
  fare_hyb_pts: number | null
  fare_hyb_cash: number | null
  scraped_at: Date
}

export interface PriceHistory {
  avg_cash_30d: number | null
  min_cash_30d: number | null
  p20_cash_30d: number | null
  avg_pts_30d: number | null
  min_pts_30d: number | null
}

export interface IFlightFaresRepository {
  insertMany(jobId: string, fares: Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'scraped_at'>[]): Promise<number>
  getLatestByRoute(airline: string, origin: string, destination: string, dateFrom: string, dateTo: string): Promise<LatestFaresByDate[]>
  getPriceHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory>
  aggregateToDailyBucket(bucketDate: string): Promise<number>
  cleanupOlderThan(days: number): Promise<number>
}
