import { Pool } from 'pg'
import { CurrentBest, FlightFareRow, IFlightFaresRepository, LatestFaresByDate, PairFareRow, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

/** A route with no collection in 30 days: no baseline, so the card gives no verdict. */
const EMPTY_HISTORY: PriceHistory = {
  currency: null,
  avg_cash_30d: null,
  min_cash_30d: null,
  p20_cash_30d: null,
  avg_pts_30d: null,
  min_pts_30d: null,
}

/**
 * A run only describes a pair once it RESOLVED the return leg: either it
 * brought inbounds, or it recorded that they were unavailable (TudoAzul login).
 *
 * Without this filter, the `DISTINCT ON ... ORDER BY scraped_at DESC` of the
 * three pair queries simply elected the most recent collection — including one
 * where the 1-to-N loop tripped on the first outbound and only outbounds went
 * up. Every total then came out NULL: the routine lost the best fare it had,
 * the calendar emptied, and the evaluation cycle found no pair to alert on. A
 * worse collection erased a good one, and the job still read as `success`.
 *
 * Requires `o` as the alias of the outbound leg in the interpolating query.
 */
const RESOLVEU_A_VOLTA = `(
        o.inbound_unavailable
        OR EXISTS (
          SELECT 1 FROM flight_fares i
          WHERE i.request_id  = o.request_id
            AND i.is_return
            AND i.return_date = o.return_date
            AND i.airline     = o.airline
            -- Volta com a rota da ida é lista de idas lida como volta; não conta
            -- como volta resolvida (ver getCurrentBestPair).
            AND NOT (i.origin = o.origin AND i.destination = o.destination)
        )
      )`

export class FlightFaresRepository implements IFlightFaresRepository {
  constructor(private readonly db: Pool) {}

  async insertMany(
    jobId: string,
    requestId: string,
    fares: Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'request_id' | 'scraped_at'>[],
  ): Promise<number> {
    if (fares.length === 0) return 0

    // A single timestamp per collection: every fare of the same run shares
    // scraped_at (freshness belongs to the run, not to each row).
    const scrapedAt = new Date()
    const values: unknown[] = []
    const placeholders: string[] = []
    let i = 1

    for (const f of fares) {
      placeholders.push(
        `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`,
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
        f.fare_cash_brl,
        f.fare_hyb_cash_brl,
        f.fx_rate,
        f.fx_rate_date,
        f.return_date,
        f.paired_outbound_flight,
        f.inbound_unavailable,
        scrapedAt,
      )
    }

    // Dedup by RUN (request_id), not by job: scraping_jobs is per route
    // (permanent), so conflicting on scraping_job_id would freeze the snapshot at
    // the first collection. Each run writes its own snapshot (price history).
    const { rowCount } = await this.db.query(
      `INSERT INTO flight_fares
         (scraping_job_id, request_id, flight_number, flight_date, is_return, origin, destination, airline,
          departure_time, arrival_time, duration_min, stops, currency,
          fare_cash, fare_pts, fare_hyb_pts, fare_hyb_cash,
          fare_cash_brl, fare_hyb_cash_brl, fx_rate, fx_rate_date, return_date,
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
   * PAIR fares (round-trip search) for the routine windows.
   *
   * Returns both legs of each collected pair, already carrying the bundle total.
   * Only rows with `return_date` filled are considered — a loose fare does not
   * enter, because it was not priced in the context of the pair.
   *
   * The pair is identified by the RUN (`request_id`): both legs of the same RT
   * search share request_id. The return leg has `flight_date` equal to ITS date
   * (the return date), not the outbound date — matching legs by flight_date split
   * the pair into two groups and every real pair was discarded as incomplete.
   * como incompleto.
   *
   * The outbound date of the pair comes from the outbound leg as `pair_outbound_date`.
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
        FROM flight_fares o
        WHERE airline = $1
          AND return_date IS NOT NULL
          AND NOT is_return
          AND flight_date BETWEEN $4 AND $5
          AND return_date BETWEEN $6 AND $7
          AND origin = $2 AND destination = $3
          AND ${RESOLVEU_A_VOLTA}
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
    // Required on purpose: a fare collected in a round-trip search is priced in
    // the context of the pair and does NOT count as a loose fare — nor the other
    // way round. Making this optional would let the two sides leak into each other.
    //   null   -> one-way fares only (return_date IS NULL)
    //   'date' -> fares of that pair only
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
    // ⚠ The baseline covers ONE currency only.
    //
    // This used to be `MAX(currency)` with AVG/MIN/PERCENTILE over every row: on a
    // route collected in two currencies the numbers were mixed and the result came
    // out labelled with whichever currency the alphabetical MAX picked. That is the
    // real case of LHR→GRU, collected in BRL as the return of the RT search leaving
    // GRU and in GBP as a one-way out of London — R$7,627 and £730 landed in the
    // same average.
    //
    // The chosen currency is the one of the MOST RECENT collection: it is what the
    // card is showing, so it is what the verdict has to compare against.
    const { rows } = await this.db.query<PriceHistory>(`
      WITH atual AS (
        SELECT currency
        FROM flight_fares
        WHERE airline = $1 AND origin = $2 AND destination = $3
          AND flight_date = $4
          AND scraped_at >= NOW() - INTERVAL '30 days'
        ORDER BY scraped_at DESC
        LIMIT 1
      )
      SELECT
        (SELECT currency FROM atual)                                      AS currency,
        AVG(fare_cash)                                                    AS avg_cash_30d,
        MIN(fare_cash)                                                    AS min_cash_30d,
        PERCENTILE_CONT(0.2) WITHIN GROUP (ORDER BY fare_cash)            AS p20_cash_30d,
        AVG(fare_pts)                                                     AS avg_pts_30d,
        MIN(fare_pts)                                                     AS min_pts_30d
      FROM flight_fares
      WHERE airline = $1 AND origin = $2 AND destination = $3
        AND flight_date = $4
        AND scraped_at >= NOW() - INTERVAL '30 days'
        AND currency = (SELECT currency FROM atual)
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

  /**
   * Historical distribution of pair TOTALS — the verdict baseline on round-trip.
   *
   * Without this the card compared the pair total (two legs) against the average
   * of a single leg, because the route `origin/destination` excludes the return,
   * which has the route inverted. The total is ~2x the baseline, so EVERY RT
   * routine said "expensive" forever — including on the best offer it ever had.
   *
   * No `DISTINCT ON` on purpose: what is wanted here is the distribution across
   * the 30 days, not a snapshot of the most recent collection.
   *
   * `INNER JOIN` on the return: a pair with no return has no total, and letting
   * it into the baseline as if it had would drag the average down.
   */
  private async getPairSummary(
    airlines: string[],
    origin: string,
    destination: string,
    outFrom: string,
    outTo: string,
    inbound: { from: string; to: string },
  ): Promise<PriceHistory> {
    const { rows } = await this.db.query<PriceHistory>(`
      WITH per_combo AS (
        SELECT
          -- Soma em Real, com a taxa congelada na coleta (017). Antes a soma era
          -- na moeda original e exigia que as duas pernas coincidissem — o que
          -- descartava todo par vindo de mercados diferentes (BA saindo de LHR:
          -- ida GBP, volta BRL). Perna sem valor em Real vira NULL e sai da
          -- régua sozinha, porque AVG e PERCENTILE ignoram NULL. O bundle é
          -- cobrado na moeda da IDA, então converte pela fx_rate dela.
          COALESCE(o.bundle_cash * o.fx_rate, o.fare_cash_brl + MIN(i.fare_cash_brl)) AS total_cash,
          COALESCE(o.bundle_pts,  o.fare_pts  + MIN(i.fare_pts))  AS total_pts
        FROM flight_fares o
        INNER JOIN flight_fares i
          ON i.request_id  = o.request_id
         AND i.return_date = o.return_date
         AND i.is_return
         AND i.airline = o.airline
         -- paired_outbound_flight NULL = coleta anterior ao vínculo 1-para-N.
         AND (i.paired_outbound_flight = o.flight_number OR i.paired_outbound_flight IS NULL)
        WHERE o.airline = ANY($1::text[])
          AND o.origin = $2 AND o.destination = $3
          AND NOT o.is_return
          AND o.return_date IS NOT NULL
          AND o.flight_date BETWEEN $4 AND $5
          AND o.return_date BETWEEN $6 AND $7
          AND o.scraped_at >= NOW() - INTERVAL '30 days'
        GROUP BY o.id
      )
      SELECT
        -- A régua de par é sempre em Real agora: a soma acontece depois da
        -- conversão gravada na coleta, então não há mais moeda "vencedora" a
        -- eleger entre as pernas.
        'BRL'                                                    AS currency,
        AVG(total_cash)                                          AS avg_cash_30d,
        MIN(total_cash)                                          AS min_cash_30d,
        PERCENTILE_CONT(0.2) WITHIN GROUP (ORDER BY total_cash)  AS p20_cash_30d,
        AVG(total_pts)                                           AS avg_pts_30d,
        MIN(total_pts)                                           AS min_pts_30d
      FROM per_combo
    `, [airlines, origin, destination, outFrom, outTo, inbound.from, inbound.to])
    return rows[0] ?? EMPTY_HISTORY
  }

  /**
   * Price baseline of the routine (30 days).
   *
   * With `inbound`, it is the distribution of PAIR totals; without, of loose fares.
   * The two branches are exclusive because the verdict compares the baseline with
   * the value shown on the card, and that value is either a pair total or a loose
   * fare — never a mixture.
   *
   * ⚠ No `stops` filter: `getCurrentBest` does not filter either, so the shown
   * value may come from a flight with a stop. A baseline of direct flights only
   * (pricier) made any cheap connection look like a historical bargain.
   */
  async getSummary(
    airlines: string[],
    origin: string,
    destination: string,
    dateFrom: string,
    dateTo: string,
    inbound?: { from: string; to: string },
  ): Promise<PriceHistory> {
    if (inbound) return this.getPairSummary(airlines, origin, destination, dateFrom, dateTo, inbound)

    const { rows } = await this.db.query<PriceHistory>(`
      WITH latest_per_date AS (
        SELECT DISTINCT ON (flight_date)
          flight_date, request_id, scraping_job_id
        FROM flight_fares
        WHERE airline = ANY($1::text[])
          AND origin = $2 AND destination = $3
          AND flight_date BETWEEN $4 AND $5
          AND is_return = false
          -- Tarifa avulsa só: a ida de um par é precificada noutro contexto e
          -- contaminaria a régua da rotina one-way.
          AND return_date IS NULL
          AND scraped_at >= NOW() - INTERVAL '30 days'
        ORDER BY flight_date, scraped_at DESC
      )
      , coletado AS (
        SELECT f.currency, f.fare_cash, f.fare_pts
        FROM flight_fares f
        INNER JOIN latest_per_date lpd
          ON f.flight_date = lpd.flight_date
         AND COALESCE(f.request_id::text, f.scraping_job_id::text)
           = COALESCE(lpd.request_id::text, lpd.scraping_job_id::text)
        WHERE f.airline = ANY($1::text[])
          AND f.origin = $2 AND f.destination = $3
          AND f.return_date IS NULL
      ),
      -- Uma moeda só na régua: a mais frequente da janela. "MAX(currency)"
      -- misturava BRL com GBP na mesma média e rotulava com o vencedor do
      -- alfabeto.
      moeda AS (SELECT mode() WITHIN GROUP (ORDER BY currency) AS c FROM coletado)
      SELECT
        (SELECT c FROM moeda)                                           AS currency,
        AVG(fare_cash)                                                  AS avg_cash_30d,
        MIN(fare_cash)                                                  AS min_cash_30d,
        PERCENTILE_CONT(0.2) WITHIN GROUP (ORDER BY fare_cash)          AS p20_cash_30d,
        AVG(fare_pts)                                                   AS avg_pts_30d,
        MIN(fare_pts)                                                   AS min_pts_30d
      FROM coletado
      WHERE currency = (SELECT c FROM moeda)
    `, [airlines, origin, destination, dateFrom, dateTo])
    return rows[0] ?? EMPTY_HISTORY
  }

  /** Lowest pair total for the routine windows (airline bundle, or sum of the same RT search). */
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
        FROM flight_fares o
        WHERE airline = ANY($1::text[])
          AND return_date IS NOT NULL
          AND NOT is_return
          AND flight_date BETWEEN $4 AND $5
          AND return_date BETWEEN $6 AND $7
          AND origin = $2 AND destination = $3
          AND scraped_at >= NOW() - INTERVAL '30 days'
          AND ${RESOLVEU_A_VOLTA}
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
          -- Em Real com a taxa congelada na coleta (017): a soma não depende
          -- mais de as duas pernas coincidirem de moeda. O bundle é cobrado na
          -- moeda da IDA, então converte pela fx_rate da própria linha de ida.
          COALESCE(o.bundle_cash     * o.fx_rate, o.fare_cash_brl     + MIN(i.fare_cash_brl))     AS total_cash,
          COALESCE(o.bundle_pts,      o.fare_pts      + MIN(i.fare_pts))      AS total_pts,
          COALESCE(o.bundle_hyb_pts,  o.fare_hyb_pts  + MIN(i.fare_hyb_pts))  AS total_hyb_pts,
          COALESCE(o.bundle_hyb_cash * o.fx_rate, o.fare_hyb_cash_brl + MIN(i.fare_hyb_cash_brl)) AS total_hyb_cash,
          -- Parcelas do total, para exibir o par segregado em ida e volta.
          -- NULL quando o total veio de bundle: aí a companhia cobrou um preço
          -- só, e inventar uma divisão mostraria um número que ela não ofereceu.
          CASE WHEN o.bundle_cash IS NULL THEN o.fare_cash_brl          END AS out_cash,
          CASE WHEN o.bundle_cash IS NULL THEN MIN(i.fare_cash_brl)     END AS in_cash,
          CASE WHEN o.bundle_pts      IS NULL THEN o.fare_pts           END AS out_pts,
          CASE WHEN o.bundle_pts      IS NULL THEN MIN(i.fare_pts)      END AS in_pts,
          CASE WHEN o.bundle_hyb_pts  IS NULL THEN o.fare_hyb_pts       END AS out_hyb_pts,
          CASE WHEN o.bundle_hyb_pts  IS NULL THEN MIN(i.fare_hyb_pts)  END AS in_hyb_pts,
          CASE WHEN o.bundle_hyb_cash IS NULL THEN o.fare_hyb_cash_brl      END AS out_hyb_cash,
          CASE WHEN o.bundle_hyb_cash IS NULL THEN MIN(i.fare_hyb_cash_brl) END AS in_hyb_cash
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
         -- Volta com a MESMA rota da ida é a lista de idas lida como volta:
         -- somaria dois trechos na mesma direção e chegou a parear o voo com
         -- ele mesmo. Filtra aqui porque o banco ainda tem linhas assim, de
         -- antes do corte na coleta. NÃO se exige a rota exatamente invertida:
         -- a BA devolve voltas LCY→GRU numa busca GRU→LHR, e são legítimas.
         AND NOT (i.origin = o.origin AND i.destination = o.destination)
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
        -- Total de par é sempre em Real (017): a conversão já aconteceu na
        -- coleta, então não há moeda a eleger entre as pernas.
        'BRL' AS currency,
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
   * Current price of the routine.
   *
   * With `inbound` (round_trip), returns the lowest PAIR TOTAL. Without, loose
   * fares only (`return_date IS NULL`). The two branches are exclusive on purpose:
   * showing the price of one leg as if it were the trip — or a pair price as if it
   * were loose — is exactly what this avoids.
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
      , coletado AS (
        SELECT f.currency, f.fare_cash, f.fare_pts, f.fare_hyb_pts, f.fare_hyb_cash, lpd.scraped_at
        FROM flight_fares f
        INNER JOIN latest_per_date lpd
          ON f.flight_date = lpd.flight_date
         AND COALESCE(f.request_id::text, f.scraping_job_id::text)
           = COALESCE(lpd.request_id::text, lpd.scraping_job_id::text)
        WHERE f.airline = ANY($1::text[]) AND f.origin = $2 AND f.destination = $3
          AND f.return_date IS NULL
      ),
      -- O MENOR preço só é comparável dentro de uma moeda: com BRL e GBP na
      -- mesma coluna, "MIN" escolheria a libra por 730 ser menor que 4.900.
      moeda AS (SELECT mode() WITHIN GROUP (ORDER BY currency) AS c FROM coletado)
      SELECT
        (SELECT c FROM moeda) AS currency,
        MIN(fare_cash)        AS best_cash,
        MIN(fare_pts)         AS best_pts,
        MIN(fare_hyb_pts)     AS best_hyb_pts,
        MIN(fare_hyb_cash)    AS best_hyb_cash,
        MAX(scraped_at)       AS scraped_at
      FROM coletado
      WHERE currency = (SELECT c FROM moeda)
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

  /**
   * Calendar of a round-trip routine: per OUTBOUND date, the lowest pair TOTAL.
   *
   * On a round trip the question the calendar answers is "which departure day
   * makes the TRIP cheapest" — not what the outbound leg costs.
   *
   * Before this variant the calendar came back empty on RT: `getPriceByDate`
   * filters `return_date IS NULL` and pair collection writes both legs with the
   * return date filled, which is what identifies the pair.
   */
  private async getPairPriceByDate(
    airlines: string[],
    origin: string,
    destination: string,
    outFrom: string,
    outTo: string,
    inbound: { from: string; to: string },
  ): Promise<PriceByDate[]> {
    const { rows } = await this.db.query<PriceByDate>(`
      WITH latest_pair AS (
        SELECT DISTINCT ON (flight_date, return_date)
          flight_date AS outbound_date, return_date, request_id
        FROM flight_fares o
        WHERE airline = ANY($1::text[])
          AND origin = $2 AND destination = $3
          AND NOT is_return
          AND return_date IS NOT NULL
          AND flight_date BETWEEN $4 AND $5
          AND return_date BETWEEN $6 AND $7
          AND scraped_at >= NOW() - INTERVAL '30 days'
          AND ${RESOLVEU_A_VOLTA}
        ORDER BY flight_date, return_date, scraped_at DESC
      ),
      -- Uma linha por combinação (ida, volta-mais-barata-daquela-ida): a volta é
      -- precificada no contexto da ida, então cruzar a ida barata com a volta
      -- barata de OUTRA ida descreveria um par que a companhia não vende.
      per_combo AS (
        SELECT
          o.flight_date,
          -- Em Real, pela taxa congelada na coleta (017). Esta query somava as
          -- duas pernas na moeda de origem sem exigir que coincidissem — era ela
          -- que exibia 725 GBP + 5761 BRL = 6486, número em unidade nenhuma, e a
          -- única das três telas de par que não tinha a guarda de moeda.
          COALESCE(o.bundle_cash     * o.fx_rate, o.fare_cash_brl     + MIN(i.fare_cash_brl))     AS total_cash,
          COALESCE(o.bundle_pts,      o.fare_pts      + MIN(i.fare_pts))      AS total_pts,
          COALESCE(o.bundle_hyb_pts,  o.fare_hyb_pts  + MIN(i.fare_hyb_pts))  AS total_hyb_pts,
          COALESCE(o.bundle_hyb_cash * o.fx_rate, o.fare_hyb_cash_brl + MIN(i.fare_hyb_cash_brl)) AS total_hyb_cash
        FROM latest_pair lp
        INNER JOIN flight_fares o
          ON o.request_id  = lp.request_id
         AND o.flight_date = lp.outbound_date
         AND o.return_date = lp.return_date
         AND NOT o.is_return
         AND o.airline = ANY($1::text[])
        INNER JOIN flight_fares i
          ON i.request_id  = lp.request_id
         AND i.return_date = lp.return_date
         AND i.is_return
         AND i.airline = o.airline
         -- Mesma regra do getCurrentBestPair: volta com a rota da ida é leitura
         -- errada da tela; volta em outro aeroporto da cidade é legítima.
         AND NOT (i.origin = o.origin AND i.destination = o.destination)
         AND (i.paired_outbound_flight = o.flight_number OR i.paired_outbound_flight IS NULL)
        GROUP BY o.id, o.flight_date
      )
      SELECT
        flight_date,
        MIN(total_cash)     AS best_cash,
        MIN(total_pts)      AS best_pts,
        MIN(total_hyb_pts)  AS best_hyb_pts,
        MIN(total_hyb_cash) AS best_hyb_cash
      FROM per_combo
      GROUP BY flight_date
      ORDER BY flight_date
    `, [airlines, origin, destination, outFrom, outTo, inbound.from, inbound.to])
    return rows
  }

  async getPriceByDate(
    airlines: string[],
    origin: string,
    destination: string,
    dateFrom: string,
    dateTo: string,
    inbound?: { from: string; to: string },
  ): Promise<PriceByDate[]> {
    if (inbound) return this.getPairPriceByDate(airlines, origin, destination, dateFrom, dateTo, inbound)

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
