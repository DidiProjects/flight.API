import { Pool } from 'pg'
import { FlightFareRow, IFlightFaresRepository, LatestFaresByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

export class FlightFaresRepository implements IFlightFaresRepository {
  constructor(private readonly db: Pool) {}

  async insertMany(
    jobId: string,
    fares: Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'scraped_at'>[],
  ): Promise<number> {
    if (fares.length === 0) return 0

    const values: unknown[] = []
    const placeholders: string[] = []
    let i = 1

    for (const f of fares) {
      placeholders.push(
        `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`,
      )
      values.push(
        jobId,
        f.flight_number,
        f.flight_date,
        f.is_return,
        f.origin,
        f.destination,
        f.airline,
        f.departure_time,
        f.arrival_time,
        f.duration_min,
        f.stops,
        f.fare_cash,
        f.fare_pts,
        f.fare_hyb_pts,
        f.fare_hyb_cash,
        new Date(),
      )
    }

    const { rowCount } = await this.db.query(
      `INSERT INTO flight_fares
         (scraping_job_id, flight_number, flight_date, is_return, origin, destination, airline,
          departure_time, arrival_time, duration_min, stops,
          fare_cash, fare_pts, fare_hyb_pts, fare_hyb_cash, scraped_at)
       VALUES ${placeholders.join(', ')}`,
      values,
    )
    return rowCount ?? 0
  }

  async getLatestByRoute(
    airline: string,
    origin: string,
    destination: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<LatestFaresByDate[]> {
    const { rows } = await this.db.query<LatestFaresByDate>(`
      SELECT
        f.airline, f.flight_date, f.is_return,
        f.departure_time, f.arrival_time, f.duration_min, f.stops,
        f.fare_cash, f.fare_pts, f.fare_hyb_pts, f.fare_hyb_cash, f.scraped_at
      FROM flight_fares f
      INNER JOIN (
        SELECT DISTINCT ON (flight_date, is_return)
          flight_date, is_return, scraping_job_id
        FROM flight_fares
        WHERE airline = $1 AND origin = $2 AND destination = $3
          AND flight_date BETWEEN $4 AND $5
        ORDER BY flight_date, is_return, scraped_at DESC
      ) latest_job
        ON f.flight_date     = latest_job.flight_date
       AND f.is_return       = latest_job.is_return
       AND f.scraping_job_id = latest_job.scraping_job_id
      WHERE f.airline = $1 AND f.origin = $2 AND f.destination = $3
      ORDER BY f.flight_date, f.is_return, f.fare_cash ASC NULLS LAST
    `, [airline, origin, destination, dateFrom, dateTo])
    return rows
  }

  async getPriceHistory(
    airline: string,
    origin: string,
    destination: string,
    flightDate: string,
  ): Promise<PriceHistory> {
    const { rows } = await this.db.query<PriceHistory>(`
      SELECT
        AVG(fare_cash)                                                    AS avg_cash_30d,
        MIN(fare_cash)                                                    AS min_cash_30d,
        PERCENTILE_CONT(0.2) WITHIN GROUP (ORDER BY fare_cash)           AS p20_cash_30d,
        AVG(fare_pts)                                                     AS avg_pts_30d,
        MIN(fare_pts)                                                     AS min_pts_30d
      FROM flight_fares
      WHERE airline = $1 AND origin = $2 AND destination = $3
        AND flight_date = $4
        AND scraped_at >= NOW() - INTERVAL '30 days'
    `, [airline, origin, destination, flightDate])
    return rows[0] ?? {
      avg_cash_30d: null,
      min_cash_30d: null,
      p20_cash_30d: null,
      avg_pts_30d: null,
      min_pts_30d: null,
    }
  }

  async aggregateToDailyBucket(bucketDate: string): Promise<number> {
    let total = 0

    for (const fareType of ['cash', 'pts', 'hyb_pts', 'hyb_cash'] as const) {
      const fareCol =
        fareType === 'cash'     ? 'fare_cash'     :
        fareType === 'pts'      ? 'fare_pts'      :
        fareType === 'hyb_pts'  ? 'fare_hyb_pts'  :
                                  'fare_hyb_cash'

      const { rowCount } = await this.db.query(`
        INSERT INTO flight_fares_daily
          (airline, origin, destination, flight_date, bucket_date, fare_type,
           price_min, price_max, price_avg, sample_count)
        SELECT
          airline, origin, destination, flight_date,
          $1::date AS bucket_date,
          $2 AS fare_type,
          MIN(${fareCol}), MAX(${fareCol}), AVG(${fareCol}),
          COUNT(*) FILTER (WHERE ${fareCol} IS NOT NULL)
        FROM flight_fares
        WHERE scraped_at::date = $1::date AND ${fareCol} IS NOT NULL
        GROUP BY airline, origin, destination, flight_date
        ON CONFLICT (airline, origin, destination, flight_date, bucket_date, fare_type)
        DO UPDATE SET
          price_min    = EXCLUDED.price_min,
          price_max    = EXCLUDED.price_max,
          price_avg    = EXCLUDED.price_avg,
          sample_count = EXCLUDED.sample_count
      `, [bucketDate, fareType])

      total += rowCount ?? 0
    }

    return total
  }

  async cleanupOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.db.query(`
      DELETE FROM flight_fares WHERE scraped_at < NOW() - ($1 || ' days')::interval
    `, [days])
    return rowCount ?? 0
  }
}
