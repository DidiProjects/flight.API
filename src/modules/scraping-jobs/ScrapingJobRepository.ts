import { Pool } from 'pg'
import { AdminJobRow, IScrapingJobRepository, ScrapingJobRow } from './interfaces/IScrapingJobRepository'

const ORPHAN_PREDICATE = `
  NOT EXISTS (
    SELECT 1 FROM routines r
    JOIN routine_airlines ra ON ra.routine_id = r.id
    WHERE r.is_active = true
      AND r.outbound_end >= CURRENT_DATE
      AND ra.airline     = j.airline
      AND r.origin       = j.origin
      AND r.destination  = j.destination
      AND j.flight_date BETWEEN r.outbound_start AND r.outbound_end
      -- Job RT só pertence a uma rotina RT cujo par de janelas o contém; job
      -- one-way (return_date NULL) só pertence a rotina one_way.
      AND (
        (j.return_date IS NULL     AND r.trip_type = 'one_way')
        OR
        (j.return_date IS NOT NULL AND r.trip_type = 'round_trip'
         AND j.return_date BETWEEN r.inbound_start AND r.inbound_end)
      )
  )`

const OWNER_EMAILS_BY_ROUTE = `
  SELECT array_agg(DISTINCT u.email ORDER BY u.email) AS emails
  FROM routines rt
  JOIN routine_airlines ra ON ra.routine_id = rt.id
  JOIN users u ON u.id = rt.user_id
  WHERE rt.is_active = true
    AND ra.airline     = j.airline
    AND rt.origin      = j.origin
    AND rt.destination = j.destination
    AND j.flight_date BETWEEN rt.outbound_start AND rt.outbound_end
    AND (
      (j.return_date IS NULL     AND rt.trip_type = 'one_way')
      OR
      (j.return_date IS NOT NULL AND rt.trip_type = 'round_trip'
       AND j.return_date BETWEEN rt.inbound_start AND rt.inbound_end)
    )
`

// Janela de espalhamento do next_run_at na criação/revival, casada com a cadência
// por proximidade — distribui o grid de datas ao longo do ciclo em vez de todas
// vencerem juntas.
const spreadWindow = (col: string) => `(CASE
  WHEN ${col} - CURRENT_DATE <= 45 THEN interval '1 hour'
  WHEN ${col} - CURRENT_DATE <= 90 THEN interval '3 hours'
  ELSE interval '6 hours'
END)`
const SPREAD_WINDOW = spreadWindow('flight_date')
const SPREAD_WINDOW_CONFLICT = spreadWindow('scraping_jobs.flight_date')

export class ScrapingJobRepository implements IScrapingJobRepository {
  constructor(private readonly db: Pool) {}

  async findRunningOrphans(): Promise<ScrapingJobRow[]> {
    const { rows } = await this.db.query<ScrapingJobRow>(
      `SELECT * FROM scraping_jobs j WHERE j.status = 'running' AND ${ORPHAN_PREDICATE}`,
    )
    return rows
  }

  async retireOrphans(): Promise<number> {
    // Aposenta jobs sem rotina ativa: marca orphaned_at e PRESERVA o status da
    // última execução (ex.: success). orphaned_at IS NULL no claimNextJob é o que
    // tira o job do pool de despacho — não precisa virar 'dead'.
    const { rowCount } = await this.db.query(
      `UPDATE scraping_jobs j
          SET orphaned_at = NOW(), updated_at = NOW()
        WHERE j.orphaned_at IS NULL
          AND j.status IN ('pending', 'failed', 'success')
          AND ${ORPHAN_PREDICATE}`,
    )
    return rowCount ?? 0
  }

  async upsertFromRoutines(): Promise<number> {
    const { rowCount } = await this.db.query(`
      INSERT INTO scraping_jobs (airline, origin, destination, flight_date, return_date, next_run_at)
      SELECT airline, origin, destination, flight_date, return_date,
             NOW() + random() * ${SPREAD_WINDOW}
      FROM (
        SELECT DISTINCT
          ra.airline,
          r.origin,
          r.destination,
          generate_series(r.outbound_start, r.outbound_end, '1 day'::interval)::date AS flight_date,
          NULL::date AS return_date
        FROM routines r
        JOIN routine_airlines ra ON ra.routine_id = r.id
        WHERE r.is_active = true
          AND r.trip_type = 'one_way'
          AND r.outbound_end >= CURRENT_DATE

        UNION

        -- Round-trip: a unidade de coleta é o PAR de datas, não a perna. Uma
        -- tarifa one-way avulsa não serve para precificar RT — se a cia dá
        -- desconto de ida-e-volta, ele só aparece na busca com as duas datas.
        -- Por isso o job carrega return_date e só casa com outro job do MESMO par.
        SELECT DISTINCT
          ra.airline,
          r.origin,
          r.destination,
          ob::date AS flight_date,
          ib::date AS return_date
        FROM routines r
        JOIN routine_airlines ra ON ra.routine_id = r.id
        CROSS JOIN LATERAL generate_series(r.outbound_start, r.outbound_end, '1 day'::interval) ob
        CROSS JOIN LATERAL generate_series(r.inbound_start,  r.inbound_end,  '1 day'::interval) ib
        WHERE r.is_active = true
          AND r.trip_type = 'round_trip'
          AND r.inbound_end >= CURRENT_DATE
          AND ib >= ob
          -- Mesmo teto de MAX_ROUNDTRIP_SPAN_MONTHS (utils/roundtrip.ts).
          AND ib <= ob + INTERVAL '3 months'
      ) g
      ON CONFLICT (airline, origin, destination, flight_date, return_date) DO UPDATE
        -- Revive job aposentado cuja rota voltou a ter rotina ativa, também espalhado.
        SET orphaned_at = NULL,
            next_run_at = NOW() + random() * ${SPREAD_WINDOW_CONFLICT},
            updated_at = NOW()
        WHERE scraping_jobs.orphaned_at IS NOT NULL
    `)
    return rowCount ?? 0
  }

  async upsertFromRoutine(routineId: string): Promise<void> {
    await this.db.query(`
      INSERT INTO scraping_jobs (airline, origin, destination, flight_date, return_date)
      SELECT DISTINCT
        ra.airline,
        r.origin,
        r.destination,
        generate_series(r.outbound_start, r.outbound_end, '1 day'::interval)::date AS flight_date,
        NULL::date AS return_date
      FROM routines r
      JOIN routine_airlines ra ON ra.routine_id = r.id
      WHERE r.id = $1
        AND r.trip_type = 'one_way'
        AND r.outbound_end >= CURRENT_DATE

      UNION

      -- Round-trip: par de datas (ver upsertFromRoutines).
      SELECT DISTINCT
        ra.airline,
        r.origin,
        r.destination,
        ob::date AS flight_date,
        ib::date AS return_date
      FROM routines r
      JOIN routine_airlines ra ON ra.routine_id = r.id
      CROSS JOIN LATERAL generate_series(r.outbound_start, r.outbound_end, '1 day'::interval) ob
      CROSS JOIN LATERAL generate_series(r.inbound_start,  r.inbound_end,  '1 day'::interval) ib
      WHERE r.id = $1
        AND r.trip_type = 'round_trip'
        AND r.inbound_end >= CURRENT_DATE
        AND ib >= ob
        AND ib <= ob + INTERVAL '3 months'
      ON CONFLICT (airline, origin, destination, flight_date, return_date) DO UPDATE
        SET next_run_at = NOW(),
            priority    = 100,
            orphaned_at = NULL,
            status      = CASE
              WHEN scraping_jobs.status = 'running' THEN 'running'
              ELSE 'pending'
            END,
            retry_count = CASE
              WHEN scraping_jobs.status = 'dead' THEN 0
              ELSE scraping_jobs.retry_count
            END,
            updated_at  = NOW()
    `, [routineId])
  }

  async expireOldJobs(): Promise<number> {
    const { rowCount } = await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'dead', updated_at = NOW()
      WHERE flight_date < CURRENT_DATE
        AND status NOT IN ('dead')
    `)
    return rowCount ?? 0
  }

  async updatePriorities(): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET priority = (
        LEAST(EXTRACT(EPOCH FROM (NOW() - COALESCE(last_success_at, created_at))) / 3600, 100) * 0.6
        +
        CASE
          WHEN flight_date - CURRENT_DATE <= 7  THEN 100
          WHEN flight_date - CURRENT_DATE <= 14 THEN 80
          WHEN flight_date - CURRENT_DATE <= 30 THEN 60
          WHEN flight_date - CURRENT_DATE <= 60 THEN 30
          ELSE 10
        END * 0.4
      )::int
      WHERE status IN ('pending', 'failed', 'success')
        AND flight_date >= CURRENT_DATE
    `)
  }

  async claimNextJob(airline: string): Promise<ScrapingJobRow | null> {
    const { rows } = await this.db.query<ScrapingJobRow>(`
      UPDATE scraping_jobs
      SET status = 'running', running_since = NOW(), started_at = NULL, updated_at = NOW()
      WHERE id = (
        SELECT id FROM scraping_jobs
        WHERE airline = $1
          AND status IN ('pending', 'failed', 'success')
          AND orphaned_at IS NULL
          AND next_run_at <= NOW()
          AND retry_count < max_retries
        ORDER BY priority DESC, next_run_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [airline])
    return rows[0] ?? null
  }

  async claimNextJobForRoutine(routineId: string): Promise<ScrapingJobRow | null> {
    const { rows } = await this.db.query<ScrapingJobRow>(`
      UPDATE scraping_jobs
      SET status = 'running', running_since = NOW(), started_at = NULL, updated_at = NOW()
      WHERE id = (
        SELECT sj.id FROM scraping_jobs sj
        JOIN routines r ON r.id = $1
        JOIN routine_airlines ra ON ra.routine_id = r.id AND ra.airline = sj.airline
        WHERE sj.origin = r.origin
          AND sj.destination = r.destination
          AND sj.flight_date BETWEEN r.outbound_start AND r.outbound_end
          AND sj.status IN ('pending', 'failed', 'success')
          AND sj.orphaned_at IS NULL
          AND sj.next_run_at <= NOW()
          AND sj.retry_count < sj.max_retries
        ORDER BY sj.priority DESC, sj.next_run_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [routineId])
    return rows[0] ?? null
  }

  async countInFlight(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scraping_jobs WHERE status = 'running'`,
    )
    return Number(rows[0]?.count ?? 0)
  }

  /**
   * Jobs em voo de UMA companhia. É o que impede duas sessões automatizadas
   * chegarem juntas no mesmo site a partir do mesmo IP: em 2026-08-20 todas as
   * nove falhas da LATAM tiveram outra sessão da LATAM rodando em paralelo, e a
   * única coleta que deu certo foi a que começou primeiro.
   */
  async countInFlightByAirline(airline: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scraping_jobs WHERE status = 'running' AND airline = $1`,
      [airline],
    )
    return Number(rows[0]?.count ?? 0)
  }

  // Segura o job sem penalidade: scraper saturado (503) não é falha do job.
  async deferJob(id: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'pending', running_since = NULL, request_id = NULL, started_at = NULL,
          next_run_at = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, nextRunAt])
  }

  async markRunning(id: string, requestId: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET request_id = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, requestId])
  }

  // Início real do scrape (telemetria job.started). A partir daqui o job conta como
  // "rodando de fato" — antes disso estava só na fila do scraper.
  async markStarted(requestId: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET started_at = NOW(), updated_at = NOW()
      WHERE request_id = $1 AND started_at IS NULL
    `, [requestId])
  }

  // Renova o lease dos jobs que o worker declarou deter (heartbeat/snapshot).
  async markHeartbeat(requestIds: string[]): Promise<void> {
    if (requestIds.length === 0) return
    await this.db.query(`
      UPDATE scraping_jobs SET last_heartbeat_at = NOW()
      WHERE status = 'running' AND request_id = ANY($1::uuid[])
    `, [requestIds])
  }

  async markSuccess(id: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'success', last_success_at = NOW(), running_since = NULL,
          request_id = NULL, retry_count = 0, last_error = NULL, next_run_at = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, nextRunAt])
  }

  async markFailed(id: string, error: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'failed', last_failure_at = NOW(), last_error = $2,
          running_since = NULL, request_id = NULL,
          retry_count = retry_count + 1, next_run_at = $3, updated_at = NOW()
      WHERE id = $1
    `, [id, error, nextRunAt])
  }

  /**
   * Falha declarada pelo próprio site da companhia.
   *
   * Não é culpa do job — é a busca da companhia que não respondeu — então não
   * pode escalar para 'dead'. Mas também não pode ficar sem freio: o contador
   * sobe para o backoff crescer, e para em `max_retries - 1` porque
   * `claimNextJob` exige `retry_count < max_retries`; parar em `max_retries`
   * deixaria o job preso para sempre, que é pior do que morto.
   */
  async markSiteError(id: string, error: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'failed', last_failure_at = NOW(), last_error = $2,
          running_since = NULL, request_id = NULL,
          retry_count = LEAST(retry_count + 1, GREATEST(max_retries - 1, 0)),
          next_run_at = $3, updated_at = NOW()
      WHERE id = $1
    `, [id, error, nextRunAt])
  }

  async markDead(id: string, error: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'dead', last_failure_at = NOW(), last_error = $2,
          running_since = NULL, request_id = NULL,
          retry_count = retry_count + 1, updated_at = NOW()
      WHERE id = $1
    `, [id, error])
  }

  // Marca a intenção de cancelamento (entregue ao worker na reconexão se estiver
  // offline). Auditoria + base do replay de cancel no snapshot.
  async setCancelRequested(requestId: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs SET cancel_requested_at = NOW(), updated_at = NOW()
      WHERE request_id = $1
    `, [requestId])
  }

  // Confirmação do cancelamento: o job volta a 'pending' com cooldown normal
  // (reagendável). 'cancelled' é terminal só da EXECUÇÃO (analysis_runs); o job
  // não morre. Cancelar NÃO é falha — retry_count não muda nem escala p/ 'dead' (§15.6).
  async releaseCancelled(requestId: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'pending', running_since = NULL, request_id = NULL,
          cancel_requested_at = NULL, next_run_at = $2, updated_at = NOW()
      WHERE request_id = $1
    `, [requestId, nextRunAt])
  }

  // Snapshot de todos os jobs relevantes para a visão Admin (estado + tempo de
  // execução via running_since). Running primeiro, depois mais recentes.
  async listForAdmin(limit = 200): Promise<AdminJobRow[]> {
    const { rows } = await this.db.query<AdminJobRow>(`
      SELECT j.*,
             COALESCE(o.emails, '{}') AS user_emails,
             r.started_at AS run_started_at, r.finished_at AS run_finished_at
      FROM scraping_jobs j
      LEFT JOIN LATERAL (${OWNER_EMAILS_BY_ROUTE}) o ON true
      LEFT JOIN LATERAL (
        SELECT started_at, finished_at FROM analysis_runs ar
        WHERE ar.scraping_job_id = j.id
        ORDER BY ar.started_at DESC
        LIMIT 1
      ) r ON true
      ORDER BY (j.status = 'running') DESC, r.started_at DESC NULLS LAST, j.updated_at DESC
      LIMIT $1
    `, [limit])
    return rows
  }

  async findOwnerEmailsByRequestId(requestId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ emails: string[] }>(`
      SELECT (${OWNER_EMAILS_BY_ROUTE}) AS emails
      FROM scraping_jobs j
      WHERE j.request_id = $1
    `, [requestId])
    return rows[0]?.emails ?? []
  }

  async pauseAirlineForBlock(airline: string, until: Date, error: string): Promise<number> {
    // IP block affects the whole airline, not a single job. Push every active job
    // of this airline past the cooldown and return it to 'pending' (including the
    // job that was 'running'). retry_count is NOT incremented — a block is not the
    // job's fault, so it must never escalate jobs to 'dead'.
    const { rowCount } = await this.db.query(`
      UPDATE scraping_jobs
      SET status        = 'pending',
          running_since = NULL,
          request_id    = NULL,
          last_error    = $3,
          next_run_at   = GREATEST(next_run_at, $2),
          updated_at    = NOW()
      WHERE airline = $1
        AND status IN ('pending', 'failed', 'running')
        AND flight_date >= CURRENT_DATE
    `, [airline, until, error])
    return rowCount ?? 0
  }

  // Reclama jobs 'running' por LEASE, não por relógio cego:
  // - lost: o lease expirou (heartbeat parou, ou nunca chegou após a graça) →
  //   worker morto/indisponível. NÃO é falha do job → volta a 'pending' sem
  //   penalidade. Job ainda vivo na fila do worker continua heartbeatando e NÃO
  //   é reclamado.
  // - hung: ainda com lease, mas rodando além do teto absoluto (watchdog deveria
  //   ter matado) → falha real: incrementa retry / vira 'dead' no limite.
  async reclaimExpiredJobs(
    leaseTimeoutSec: number,
    graceSec: number,
    maxRunMin: number,
  ): Promise<{ lost: string[]; hung: string[] }> {
    const lost = await this.db.query<{ request_id: string | null }>(`
      WITH expired AS (
        SELECT id, request_id FROM scraping_jobs
        WHERE status = 'running'
          AND (
            (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval)
            OR (last_heartbeat_at IS NULL AND running_since < NOW() - ($2 || ' seconds')::interval)
          )
        FOR UPDATE SKIP LOCKED
      )
      UPDATE scraping_jobs j
      SET status = 'pending', running_since = NULL, request_id = NULL,
          started_at = NULL, last_heartbeat_at = NULL,
          next_run_at = NOW() + random() * INTERVAL '5 minutes',
          updated_at = NOW()
      FROM expired WHERE j.id = expired.id
      RETURNING expired.request_id
    `, [leaseTimeoutSec, graceSec])

    const hung = await this.db.query<{ request_id: string | null }>(`
      WITH stuck AS (
        SELECT id, request_id FROM scraping_jobs
        WHERE status = 'running'
          AND last_heartbeat_at >= NOW() - ($1 || ' seconds')::interval
          AND started_at IS NOT NULL
          AND started_at < NOW() - ($2 || ' minutes')::interval
        FOR UPDATE SKIP LOCKED
      )
      UPDATE scraping_jobs j
      SET status = CASE WHEN j.retry_count + 1 >= j.max_retries THEN 'dead' ELSE 'pending' END,
          running_since = NULL, request_id = NULL, started_at = NULL, last_heartbeat_at = NULL,
          retry_count = j.retry_count + 1,
          last_error = CASE WHEN j.retry_count + 1 >= j.max_retries
                            THEN COALESCE(j.last_error, 'Excedeu o tempo máximo de execução — max retries atingido')
                            ELSE j.last_error END,
          last_failure_at = CASE WHEN j.retry_count + 1 >= j.max_retries THEN NOW() ELSE j.last_failure_at END,
          next_run_at = NOW() + INTERVAL '2 minutes',
          updated_at = NOW()
      FROM stuck WHERE j.id = stuck.id
      RETURNING stuck.request_id
    `, [leaseTimeoutSec, maxRunMin])

    const ids = (r: { request_id: string | null }[]) => r.map((x) => x.request_id).filter((x): x is string => !!x)
    return { lost: ids(lost.rows), hung: ids(hung.rows) }
  }

  async findByRequestId(requestId: string): Promise<ScrapingJobRow | null> {
    const { rows } = await this.db.query<ScrapingJobRow>(`
      SELECT * FROM scraping_jobs WHERE request_id = $1
    `, [requestId])
    return rows[0] ?? null
  }

  async findById(id: string): Promise<ScrapingJobRow | null> {
    const { rows } = await this.db.query<ScrapingJobRow>(`
      SELECT * FROM scraping_jobs WHERE id = $1
    `, [id])
    return rows[0] ?? null
  }

  async getActiveAirlines(): Promise<string[]> {
    const { rows } = await this.db.query<{ airline: string }>(`
      SELECT DISTINCT airline FROM scraping_jobs
      WHERE status IN ('pending', 'failed', 'success')
        AND next_run_at <= NOW()
        AND retry_count < max_retries
        AND flight_date >= CURRENT_DATE
    `)
    return rows.map((r) => r.airline)
  }

  async cleanupDeadJobs(): Promise<number> {
    const { rowCount } = await this.db.query(`
      DELETE FROM scraping_jobs
      WHERE status = 'dead'
        AND updated_at < NOW() - INTERVAL '30 days'
    `)
    return rowCount ?? 0
  }
}
