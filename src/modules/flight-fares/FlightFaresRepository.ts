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
        `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`,
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
        f.paired_outbound_flight,
        f.inbound_unavailable,
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
          fare_cash, fare_pts, fare_hyb_pts, fare_hyb_cash, return_date,
          paired_outbound_flight, inbound_unavailable, scraped_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (request_id, flight_date, is_return, flight_number, paired_outbound_flight)
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
   * O par é identificado pela EXECUÇÃO (`request_id`): as duas pernas da mesma
   * busca RT compartilham request_id. A perna de volta tem `flight_date` igual à
   * data DELA (a data de volta), não à data da ida — casar as pernas por
   * flight_date separava o par em dois grupos e todo par real era descartado
   * como incompleto.
   *
   * A data de ida do par vem da perna de ida e volta em `pair_outbound_date`.
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
        f.request_id, latest.outbound_date AS pair_outbound_date,
        f.flight_number, f.paired_outbound_flight, f.inbound_unavailable,
        f.departure_time, f.arrival_time, f.duration_min, f.stops, f.currency,
        f.fare_cash, f.fare_pts, f.fare_hyb_pts, f.fare_hyb_cash,
        f.bundle_cash, f.bundle_pts, f.bundle_hyb_pts, f.bundle_hyb_cash,
        f.scraped_at
      FROM flight_fares f
      INNER JOIN (
        -- Snapshot mais recente de cada par. As datas do par vêm da perna de
        -- IDA: é ela que tem flight_date = data de ida e return_date = data de
        -- volta. A perna de volta tem flight_date = data DELA.
        SELECT DISTINCT ON (flight_date, return_date)
          flight_date AS outbound_date, return_date, request_id
        FROM flight_fares
        WHERE airline = $1
          AND return_date IS NOT NULL
          AND NOT is_return
          AND flight_date BETWEEN $4 AND $5
          AND return_date BETWEEN $6 AND $7
          AND origin = $2 AND destination = $3
        ORDER BY flight_date, return_date, scraped_at DESC
      ) latest
        -- request_id é a identidade do par: as duas pernas saem da mesma busca.
        ON f.request_id = latest.request_id
      WHERE f.airline = $1
        AND f.return_date = latest.return_date
        ${freshFilter}
      ORDER BY latest.outbound_date, f.return_date, f.is_return, f.fare_cash ASC NULLS LAST
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
        -- Datas do par pela perna de IDA; a de volta tem flight_date igual à
        -- data dela. O par é identificado pelo request_id da busca.
        SELECT DISTINCT ON (flight_date, return_date)
          flight_date AS outbound_date, return_date, request_id, scraped_at
        FROM flight_fares
        WHERE airline = ANY($1::text[])
          AND return_date IS NOT NULL
          AND NOT is_return
          AND flight_date BETWEEN $4 AND $5
          AND return_date BETWEEN $6 AND $7
          AND origin = $2 AND destination = $3
          AND scraped_at >= NOW() - INTERVAL '30 days'
        ORDER BY flight_date, return_date, scraped_at DESC
      ),
      -- Uma linha por COMBINAÇÃO (ida, volta-mais-barata-daquela-ida), não por
      -- par de datas: a volta é precificada no contexto da ida, então somar o
      -- mínimo das idas com o mínimo de todas as voltas mostraria um total que a
      -- companhia nunca ofereceu.
      per_combo AS (
        SELECT
          lp.scraped_at,
          o.currency,
          o.inbound_unavailable,
          -- Bundle da companhia manda; sem ele, ida + a volta mais barata DELA.
          COALESCE(o.bundle_cash,     o.fare_cash     + MIN(i.fare_cash))     AS total_cash,
          COALESCE(o.bundle_pts,      o.fare_pts      + MIN(i.fare_pts))      AS total_pts,
          COALESCE(o.bundle_hyb_pts,  o.fare_hyb_pts  + MIN(i.fare_hyb_pts))  AS total_hyb_pts,
          COALESCE(o.bundle_hyb_cash, o.fare_hyb_cash + MIN(i.fare_hyb_cash)) AS total_hyb_cash,
          -- Parcelas do total, para exibir o par segregado em ida e volta.
          -- NULL quando o total veio de bundle: aí a companhia cobrou um preço
          -- só, e inventar uma divisão mostraria um número que ela não ofereceu.
          CASE WHEN o.bundle_cash     IS NULL THEN o.fare_cash          END AS out_cash,
          CASE WHEN o.bundle_cash     IS NULL THEN MIN(i.fare_cash)     END AS in_cash,
          CASE WHEN o.bundle_pts      IS NULL THEN o.fare_pts           END AS out_pts,
          CASE WHEN o.bundle_pts      IS NULL THEN MIN(i.fare_pts)      END AS in_pts,
          CASE WHEN o.bundle_hyb_pts  IS NULL THEN o.fare_hyb_pts       END AS out_hyb_pts,
          CASE WHEN o.bundle_hyb_pts  IS NULL THEN MIN(i.fare_hyb_pts)  END AS in_hyb_pts,
          CASE WHEN o.bundle_hyb_cash IS NULL THEN o.fare_hyb_cash      END AS out_hyb_cash,
          CASE WHEN o.bundle_hyb_cash IS NULL THEN MIN(i.fare_hyb_cash) END AS in_hyb_cash
        FROM latest_pair lp
        INNER JOIN flight_fares o
          ON o.request_id  = lp.request_id
         AND o.flight_date = lp.outbound_date
         AND o.return_date = lp.return_date
         AND NOT o.is_return
         AND o.airline = ANY($1::text[])
        -- LEFT JOIN de propósito: ida cuja volta é indefinida (login do TudoAzul)
        -- fica com total NULL e a rotina exibe "-", em vez de mostrar o preço da
        -- ida como se fosse o da viagem.
        LEFT JOIN flight_fares i
          ON i.request_id  = lp.request_id
         AND i.return_date = lp.return_date
         AND i.is_return
         AND i.airline = o.airline
         -- paired_outbound_flight NULL = coleta anterior ao vínculo 1-para-N.
         AND (i.paired_outbound_flight = o.flight_number OR i.paired_outbound_flight IS NULL)
        GROUP BY lp.scraped_at, o.id
      ),
      -- As parcelas têm de vir da MESMA combinação que ganhou cada dimensão.
      -- Pegar o menor out e o menor in separadamente descreveria um par que a
      -- companhia não vendeu — a volta barata pode pertencer a outra ida.
      win_cash     AS (SELECT out_cash,     in_cash     FROM per_combo WHERE total_cash     IS NOT NULL ORDER BY total_cash     LIMIT 1),
      win_pts      AS (SELECT out_pts,      in_pts      FROM per_combo WHERE total_pts      IS NOT NULL ORDER BY total_pts      LIMIT 1),
      win_hyb_pts  AS (SELECT out_hyb_pts,  in_hyb_pts  FROM per_combo WHERE total_hyb_pts  IS NOT NULL ORDER BY total_hyb_pts  LIMIT 1),
      win_hyb_cash AS (SELECT out_hyb_cash, in_hyb_cash FROM per_combo WHERE total_hyb_cash IS NOT NULL ORDER BY total_hyb_cash LIMIT 1)
      SELECT
        MAX(currency)       AS currency,
        MIN(total_cash)     AS best_cash,
        MIN(total_pts)      AS best_pts,
        MIN(total_hyb_pts)  AS best_hyb_pts,
        MIN(total_hyb_cash) AS best_hyb_cash,
        (SELECT out_cash     FROM win_cash)     AS best_cash_outbound,
        (SELECT in_cash      FROM win_cash)     AS best_cash_inbound,
        (SELECT out_pts      FROM win_pts)      AS best_pts_outbound,
        (SELECT in_pts       FROM win_pts)      AS best_pts_inbound,
        (SELECT out_hyb_pts  FROM win_hyb_pts)  AS best_hyb_pts_outbound,
        (SELECT in_hyb_pts   FROM win_hyb_pts)  AS best_hyb_pts_inbound,
        (SELECT out_hyb_cash FROM win_hyb_cash) AS best_hyb_cash_outbound,
        (SELECT in_hyb_cash  FROM win_hyb_cash) AS best_hyb_cash_inbound,
        MAX(scraped_at)     AS scraped_at,
        -- Só quando NENHUMA dimensão fechou total e existe ida com volta
        -- indefinida: aí o "sem total" tem motivo conhecido, e a rotina exibe
        -- isso em vez de "nada coletado".
        (MIN(total_cash) IS NULL AND MIN(total_pts) IS NULL
         AND MIN(total_hyb_pts) IS NULL AND MIN(total_hyb_cash) IS NULL
         AND BOOL_OR(inbound_unavailable)) AS inbound_unavailable
      FROM per_combo
    `, [airlines, origin, destination, outFrom, outTo, inbound.from, inbound.to])

    return rows[0] ?? {
      currency: null, best_cash: null, best_pts: null,
      best_hyb_pts: null, best_hyb_cash: null, scraped_at: null,
      inbound_unavailable: false,
      best_cash_outbound: null, best_cash_inbound: null,
      best_pts_outbound: null, best_pts_inbound: null,
      best_hyb_pts_outbound: null, best_hyb_pts_inbound: null,
      best_hyb_cash_outbound: null, best_hyb_cash_inbound: null,
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
