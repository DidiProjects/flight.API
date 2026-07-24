import { Pool } from 'pg'
import { CurrentBest, FlightFareRow, IFlightFaresRepository, LatestFaresByDate, PairFareRow, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

export class FlightFaresRepository implements IFlightFaresRepository {
  constructor(private readonly db: Pool) {}

  async insertMany(
    jobId: string,
    requestId: string,
    fares: Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'request_id' | 'scraped_at'>[],
  ): Promise<number> {
    if (fares.length === 0) return 0

    // Um único timestamp por coleta: todas as tarifas da mesma execução
    // compartilham scraped_at (a frescura é da run, não de cada linha).
    const scrapedAt = new Date()
    const values: unknown[] = []
    const placeholders: string[] = []
    let i = 1

    for (const f of fares) {
      placeholders.push(
        `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`,
      )
      values.push(
        jobId,
        requestId,
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
        f.currency,
        f.fare_cash,
        f.fare_pts,
        f.fare_hyb_pts,
        f.fare_hyb_cash,
        f.return_date,
        scrapedAt,
      )
    }

    // Dedup por EXECUÇÃO (request_id), não por job: scraping_jobs é por rota
    // (permanente), então conflitar em scraping_job_id congelaria o snapshot na
    // primeira coleta. Cada run grava seu próprio snapshot (histórico de preço).
    const { rowCount } = await this.db.query(
      `INSERT INTO flight_fares
         (scraping_job_id, request_id, flight_number, flight_date, is_return, origin, destination, airline,
          departure_time, arrival_time, duration_min, stops, currency,
          fare_cash, fare_pts, fare_hyb_pts, fare_hyb_cash, return_date, scraped_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (request_id, flight_date, is_return, flight_number)
         WHERE flight_number IS NOT NULL AND request_id IS NOT NULL
       DO NOTHING`,
      values,
    )
    return rowCount ?? 0
  }

  /**
   * Tarifas de PAR (busca ida-e-volta) para as janelas da rotina.
   *
   * Devolve as duas pernas de cada par colhido, já trazendo o total do bundle.
   * Só considera linhas com `return_date` preenchido — tarifa avulsa não entra,
   * porque não foi precificada no contexto do par.
   *
   * A perna de ida vem como (origin -> destination) e a de volta como a rota
   * invertida, ambas compartilhando (flight_date, return_date).
   */
  async getLatestPairs(
    airline: string,
    origin: string,
    destination: string,
    outFrom: string,
    outTo: string,
    inFrom: string,
    inTo: string,
    maxAgeHours?: number,
  ): Promise<PairFareRow[]> {
    const params: unknown[] = [airline, origin, destination, outFrom, outTo, inFrom, inTo]
    const freshFilter =
      maxAgeHours != null
        ? `AND f.scraped_at >= NOW() - ($${params.push(maxAgeHours)} || ' hours')::interval`
        : ''

    const { rows } = await this.db.query<PairFareRow>(`
      SELECT
        f.airline, f.flight_date, f.return_date, f.is_return,
        f.origin, f.destination,
        f.departure_time, f.arrival_time, f.duration_min, f.stops, f.currency,
        f.fare_cash, f.fare_pts, f.fare_hyb_pts, f.fare_hyb_cash,
        f.bundle_cash, f.bundle_pts, f.bundle_hyb_pts, f.bundle_hyb_cash,
        f.scraped_at
      FROM flight_fares f
      INNER JOIN (
        -- Snapshot mais recente de cada par.
        SELECT DISTINCT ON (flight_date, return_date)
          flight_date, return_date, request_id
        FROM flight_fares
        WHERE airline = $1
          AND return_date IS NOT NULL
          AND flight_date BETWEEN $4 AND $5
          AND return_date BETWEEN $6 AND $7
          AND ((origin = $2 AND destination = $3) OR (origin = $3 AND destination = $2))
        ORDER BY flight_date, return_date, scraped_at DESC
      ) latest
        ON f.flight_date = latest.flight_date
       AND f.return_date = latest.return_date
       AND f.request_id  = latest.request_id
      WHERE f.airline = $1
        ${freshFilter}
      ORDER BY f.flight_date, f.return_date, f.is_return, f.fare_cash ASC NULLS LAST
    `, params)
    return rows
  }

  async getLatestByRoute(
    airline: string,
    origin: string,
    destination: string,
    dateFrom: string,
    dateTo: string,
    // Obrigatório de propósito: tarifa colhida numa busca ida-e-volta é
    // precificada no contexto do par e NÃO vale como tarifa avulsa — nem o
    // contrário. Deixar isto opcional deixaria os dois lados vazarem um no outro.
    //   null   -> só tarifas one-way (return_date IS NULL)
    //   'date' -> só tarifas daquele par
    returnDate: string | null,
    maxAgeHours?: number,
  ): Promise<LatestFaresByDate[]> {
    const params: unknown[] = [airline, origin, destination, dateFrom, dateTo]
    const pairFilter =
      returnDate == null
        ? 'AND return_date IS NULL'
        : `AND return_date = $${params.push(returnDate)}::date`
    const outerPairFilter =
      returnDate == null
        ? 'AND f.return_date IS NULL'
        : `AND f.return_date = $${params.length}::date`
    const freshFilter =
      maxAgeHours != null
        ? `AND scraped_at >= NOW() - ($${params.push(maxAgeHours)} || ' hours')::interval`
        : ''

    const { rows } = await this.db.query<LatestFaresByDate>(`
      SELECT
        f.airline, f.flight_date, f.is_return,
        f.departure_time, f.arrival_time, f.duration_min, f.stops, f.currency,
        f.fare_cash, f.fare_pts, f.fare_hyb_pts, f.fare_hyb_cash, f.scraped_at
      FROM flight_fares f
      INNER JOIN (
        SELECT DISTINCT ON (flight_date, is_return)
          flight_date, is_return, request_id, scraping_job_id
        FROM flight_fares
        WHERE airline = $1 AND origin = $2 AND destination = $3
          AND flight_date BETWEEN $4 AND $5
          ${pairFilter}
          ${freshFilter}
        ORDER BY flight_date, is_return, scraped_at DESC
      ) latest_job
        ON f.flight_date = latest_job.flight_date
       AND f.is_return   = latest_job.is_return
       AND COALESCE(f.request_id::text, f.scraping_job_id::text)
         = COALESCE(latest_job.request_id::text, latest_job.scraping_job_id::text)
      WHERE f.airline = $1 AND f.origin = $2 AND f.destination = $3
        ${outerPairFilter}
      ORDER BY f.flight_date, f.is_return, f.fare_cash ASC NULLS LAST
    `, params)
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
        MAX(currency) FILTER (WHERE currency IS NOT NULL)                 AS currency,
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
      currency: null,
      avg_cash_30d: null,
      min_cash_30d: null,
      p20_cash_30d: null,
      avg_pts_30d: null,
      min_pts_30d: null,
    }
  }

  async getSummary(
    airlines: string[],
    origin: string,
    destination: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<PriceHistory> {
    const { rows } = await this.db.query<PriceHistory>(`
      WITH latest_per_date AS (
        SELECT DISTINCT ON (flight_date, is_return)
          flight_date, is_return, request_id, scraping_job_id
        FROM flight_fares
        WHERE airline = ANY($1::text[])
          AND origin = $2 AND destination = $3
          AND flight_date BETWEEN $4 AND $5
          AND stops = 0
          AND scraped_at >= NOW() - INTERVAL '30 days'
        ORDER BY flight_date, is_return, scraped_at DESC
      )
      SELECT
        MAX(f.currency) FILTER (WHERE f.currency IS NOT NULL)           AS currency,
        AVG(f.fare_cash)                                                AS avg_cash_30d,
        MIN(f.fare_cash)                                                AS min_cash_30d,
        PERCENTILE_CONT(0.2) WITHIN GROUP (ORDER BY f.fare_cash)        AS p20_cash_30d,
        AVG(f.fare_pts)                                                 AS avg_pts_30d,
        MIN(f.fare_pts)                                                 AS min_pts_30d
      FROM flight_fares f
      INNER JOIN latest_per_date lpd
        ON f.flight_date = lpd.flight_date
       AND f.is_return   = lpd.is_return
       AND COALESCE(f.request_id::text, f.scraping_job_id::text)
         = COALESCE(lpd.request_id::text, lpd.scraping_job_id::text)
      WHERE f.airline = ANY($1::text[])
        AND f.origin = $2 AND f.destination = $3
        AND f.stops = 0
    `, [airlines, origin, destination, dateFrom, dateTo])
    return rows[0] ?? {
      currency: null,
      avg_cash_30d: null,
      min_cash_30d: null,
      p20_cash_30d: null,
      avg_pts_30d: null,
      min_pts_30d: null,
    }
  }

  /** Menor total de par para as janelas da rotina (bundle da cia, ou soma da mesma busca RT). */
  private async getCurrentBestPair(
    airlines: string[],
    origin: string,
    destination: string,
    outFrom: string,
    outTo: string,
    inbound: { from: string; to: string },
  ): Promise<CurrentBest> {
    const { rows } = await this.db.query<CurrentBest>(`
      WITH latest_pair AS (
        SELECT DISTINCT ON (flight_date, return_date)
          flight_date, return_date, request_id, scraped_at
        FROM flight_fares
        WHERE airline = ANY($1::text[])
          AND return_date IS NOT NULL
          AND flight_date BETWEEN $4 AND $5
          AND return_date BETWEEN $6 AND $7
          AND ((origin = $2 AND destination = $3) OR (origin = $3 AND destination = $2))
          AND scraped_at >= NOW() - INTERVAL '30 days'
        ORDER BY flight_date, return_date, scraped_at DESC
      ),
      per_pair AS (
        SELECT
          lp.scraped_at,
          MAX(f.currency) FILTER (WHERE f.currency IS NOT NULL) AS currency,
          -- Bundle da companhia manda; sem ele, soma das pernas DA MESMA busca.
          COALESCE(MAX(f.bundle_cash),
            MIN(f.fare_cash) FILTER (WHERE NOT f.is_return) + MIN(f.fare_cash) FILTER (WHERE f.is_return)) AS total_cash,
          COALESCE(MAX(f.bundle_pts),
            MIN(f.fare_pts) FILTER (WHERE NOT f.is_return) + MIN(f.fare_pts) FILTER (WHERE f.is_return)) AS total_pts,
          COALESCE(MAX(f.bundle_hyb_pts),
            MIN(f.fare_hyb_pts) FILTER (WHERE NOT f.is_return) + MIN(f.fare_hyb_pts) FILTER (WHERE f.is_return)) AS total_hyb_pts,
          COALESCE(MAX(f.bundle_hyb_cash),
            MIN(f.fare_hyb_cash) FILTER (WHERE NOT f.is_return) + MIN(f.fare_hyb_cash) FILTER (WHERE f.is_return)) AS total_hyb_cash
        FROM flight_fares f
        INNER JOIN latest_pair lp
          ON f.flight_date = lp.flight_date
         AND f.return_date = lp.return_date
         AND f.request_id  = lp.request_id
        WHERE f.airline = ANY($1::text[])
        GROUP BY lp.flight_date, lp.return_date, lp.scraped_at
      )
      SELECT
        MAX(currency)       AS currency,
        MIN(total_cash)     AS best_cash,
        MIN(total_pts)      AS best_pts,
        MIN(total_hyb_pts)  AS best_hyb_pts,
        MIN(total_hyb_cash) AS best_hyb_cash,
        MAX(scraped_at)     AS scraped_at
      FROM per_pair
    `, [airlines, origin, destination, outFrom, outTo, inbound.from, inbound.to])

    return rows[0] ?? {
      currency: null, best_cash: null, best_pts: null,
      best_hyb_pts: null, best_hyb_cash: null, scraped_at: null,
    }
  }

  /**
   * Preço atual da rotina.
   *
   * Com `inbound` (round_trip), devolve o menor TOTAL DE PAR. Sem, só tarifa
   * avulsa (`return_date IS NULL`). Os dois ramos são exclusivos de propósito:
   * mostrar o preço de uma perna como se fosse o da viagem — ou o preço de par
   * como se fosse avulso — é exatamente o que se quer evitar.
   */
  async getCurrentBest(
    airlines: string[],
    origin: string,
    destination: string,
    dateFrom: string,
    dateTo: string,
    inbound?: { from: string; to: string },
  ): Promise<CurrentBest> {
    if (inbound) return this.getCurrentBestPair(airlines, origin, destination, dateFrom, dateTo, inbound)

    const { rows } = await this.db.query<CurrentBest>(`
      WITH latest_per_date AS (
        SELECT DISTINCT ON (flight_date)
          flight_date, request_id, scraping_job_id, scraped_at
        FROM flight_fares
        WHERE airline = ANY($1::text[])
          AND origin = $2 AND destination = $3
          AND flight_date BETWEEN $4 AND $5
          AND is_return = false
          AND return_date IS NULL
          AND scraped_at >= NOW() - INTERVAL '30 days'
        ORDER BY flight_date, scraped_at DESC
      )
      SELECT
        MAX(f.currency) FILTER (WHERE f.currency IS NOT NULL) AS currency,
        MIN(f.fare_cash)     AS best_cash,
        MIN(f.fare_pts)      AS best_pts,
        MIN(f.fare_hyb_pts)  AS best_hyb_pts,
        MIN(f.fare_hyb_cash) AS best_hyb_cash,
        MAX(lpd.scraped_at)  AS scraped_at
      FROM flight_fares f
      INNER JOIN latest_per_date lpd
        ON f.flight_date = lpd.flight_date
       AND COALESCE(f.request_id::text, f.scraping_job_id::text)
         = COALESCE(lpd.request_id::text, lpd.scraping_job_id::text)
      WHERE f.airline = ANY($1::text[]) AND f.origin = $2 AND f.destination = $3
        AND f.return_date IS NULL
    `, [airlines, origin, destination, dateFrom, dateTo])

    return rows[0] ?? {
      currency: null,
      best_cash: null,
      best_pts: null,
      best_hyb_pts: null,
      best_hyb_cash: null,
      scraped_at: null,
    }
  }

  async getPriceByDate(
    airlines: string[],
    origin: string,
    destination: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<PriceByDate[]> {
    const { rows } = await this.db.query<PriceByDate>(`
      WITH latest_per_date AS (
        SELECT DISTINCT ON (flight_date)
          flight_date, request_id, scraping_job_id
        FROM flight_fares
        WHERE airline = ANY($1::text[])
          AND origin = $2 AND destination = $3
          AND flight_date BETWEEN $4 AND $5
          AND is_return = false
          AND return_date IS NULL
          AND scraped_at >= NOW() - INTERVAL '30 days'
        ORDER BY flight_date, scraped_at DESC
      )
      SELECT
        f.flight_date,
        MIN(f.fare_cash)     AS best_cash,
        MIN(f.fare_pts)      AS best_pts,
        MIN(f.fare_hyb_pts)  AS best_hyb_pts,
        MIN(f.fare_hyb_cash) AS best_hyb_cash
      FROM flight_fares f
      INNER JOIN latest_per_date lpd
        ON f.flight_date = lpd.flight_date
       AND COALESCE(f.request_id::text, f.scraping_job_id::text)
         = COALESCE(lpd.request_id::text, lpd.scraping_job_id::text)
      WHERE f.airline = ANY($1::text[]) AND f.origin = $2 AND f.destination = $3
        AND f.return_date IS NULL
      GROUP BY f.flight_date
      ORDER BY f.flight_date
    `, [airlines, origin, destination, dateFrom, dateTo])
    return rows
  }

  async getKnownCurrency(
    airlines: string[],
    origin: string,
    destination: string,
  ): Promise<string | null> {
    const { rows } = await this.db.query<{ currency: string | null }>(`
      SELECT currency
      FROM flight_fares
      WHERE airline = ANY($1::text[])
        AND origin = $2 AND destination = $3
        AND currency IS NOT NULL
      ORDER BY scraped_at DESC
      LIMIT 1
    `, [airlines, origin, destination])
    return rows[0]?.currency ?? null
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
