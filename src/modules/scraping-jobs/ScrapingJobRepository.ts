import { Pool } from 'pg'
import { AdminJobRow, IScrapingJobRepository, ResetJobsResult, ScrapingJobRow } from './interfaces/IScrapingJobRepository'

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

// A row belongs to a routine by ROUTE, not by ownership: same airline, same
// trip, date inside the window — and, for round-trip, the pair of dates inside
// the pair of windows. `alias` is a parameter because the same condition serves
// scraping_jobs and analysis_runs, which carry the same four columns plus
// return_date. Mirrors ORPHAN_PREDICATE above, narrowed to one routine.
export const belongsToRoutine = (alias: string, routineIdComparison: string) => `
  EXISTS (
    SELECT 1 FROM routines r
    JOIN routine_airlines ra ON ra.routine_id = r.id
    WHERE r.id ${routineIdComparison}
      AND ra.airline    = ${alias}.airline
      AND r.origin      = ${alias}.origin
      AND r.destination = ${alias}.destination
      AND ${alias}.flight_date BETWEEN r.outbound_start AND r.outbound_end
      AND (
        (${alias}.return_date IS NULL     AND r.trip_type = 'one_way')
        OR
        (${alias}.return_date IS NOT NULL AND r.trip_type = 'round_trip'
         AND ${alias}.return_date BETWEEN r.inbound_start AND r.inbound_end)
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

// Spread window for next_run_at on creation/revival, matched to the proximity
// cadence — it distributes the date grid across the cycle instead of having them
// all come due together. Mirrors calcNextRunAt: the two must move together, or
// the grid is spread over a window that no longer matches its own cadence.
const spreadWindow = (col: string) => `(CASE
  WHEN ${col} - CURRENT_DATE <= 45 THEN interval '4 hours'
  WHEN ${col} - CURRENT_DATE <= 90 THEN interval '8 hours'
  ELSE interval '12 hours'
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
    // Retires jobs with no active routine: marks orphaned_at and PRESERVES the
    // status of the last run (e.g. success). orphaned_at IS NULL in claimNextJob is
    // what takes the job out of the dispatch pool — it need not become 'dead'.
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

  /**
   * `last_heartbeat_at = NULL` is the whole point of this line.
   *
   * The column is the worker's lease. A row that already ran carries the
   * heartbeat of THAT run, and `reclaimExpiredJobs` reads it as a lease expired
   * ages ago — so the job was taken back seconds after being dispatched, the
   * worker got a cancel mid-scrape, and the late callback landed as an orphan
   * that leaves the job untouched: no retry counted, no backoff applied, the
   * whole cycle again in five minutes. Measured on 2026-08-23 in development and
   * seen in production on the 24th, where a failing BA route retried for hours
   * without ever reaching `dead`.
   *
   * With it NULL, the reclaim falls to the grace path (`running_since` older
   * than the grace), which is the window the worker has to send its first
   * heartbeat — and its snapshot already includes queued jobs, so a job waiting
   * in the scraper queue keeps its lease renewed.
   */
  async claimNextJob(airline: string): Promise<ScrapingJobRow | null> {
    const { rows } = await this.db.query<ScrapingJobRow>(`
      UPDATE scraping_jobs
      SET status = 'running', running_since = NOW(), started_at = NULL,
          last_heartbeat_at = NULL, updated_at = NOW()
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

  /** Same lease reset as `claimNextJob` — see the note there. */
  async claimNextJobForRoutine(routineId: string): Promise<ScrapingJobRow | null> {
    const { rows } = await this.db.query<ScrapingJobRow>(`
      UPDATE scraping_jobs
      SET status = 'running', running_since = NOW(), started_at = NULL,
          last_heartbeat_at = NULL, updated_at = NOW()
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
   * In-flight jobs of ONE airline. This is what keeps two automated sessions from
   * reaching the same site together from the same IP: on 2026-08-20 all nine LATAM
   * failures had another LATAM session running in parallel, and the only collection
   * that worked was the one that started first.
   */
  async countInFlightByAirline(airline: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scraping_jobs WHERE status = 'running' AND airline = $1`,
      [airline],
    )
    return Number(rows[0]?.count ?? 0)
  }

  // Holds the job with no penalty: a saturated scraper (503) is not a job failure.
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

  // Real start of the scrape (job.started telemetry). From here the job counts as
  // "actually running" — before that it was only in the scraper queue.
  async markStarted(requestId: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET started_at = NOW(), updated_at = NOW()
      WHERE request_id = $1 AND started_at IS NULL
    `, [requestId])
  }

  // Renews the lease of the jobs the worker declared it holds (heartbeat/snapshot).
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
          request_id = NULL, last_heartbeat_at = NULL, retry_count = 0, last_error = NULL,
          next_run_at = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, nextRunAt])
  }

  async markFailed(id: string, error: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'failed', last_failure_at = NOW(), last_error = $2,
          running_since = NULL, request_id = NULL, last_heartbeat_at = NULL,
          retry_count = retry_count + 1, next_run_at = $3, updated_at = NOW()
      WHERE id = $1
    `, [id, error, nextRunAt])
  }

  /**
   * Failure declared by the airline site itself.
   *
   * Not the job's fault — it is the airline search that did not respond — so it
   * must not escalate to 'dead'. But it cannot go unchecked either: the counter
   * rises so the backoff grows, and stops at `max_retries - 1` because
   * `claimNextJob` requires `retry_count < max_retries`; stopping at `max_retries`
   * would leave the job stuck forever, which is worse than dead.
   */
  async markSiteError(id: string, error: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'failed', last_failure_at = NOW(), last_error = $2,
          running_since = NULL, request_id = NULL, last_heartbeat_at = NULL,
          retry_count = LEAST(retry_count + 1, GREATEST(max_retries - 1, 0)),
          next_run_at = $3, updated_at = NOW()
      WHERE id = $1
    `, [id, error, nextRunAt])
  }

  async markDead(id: string, error: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'dead', last_failure_at = NOW(), last_error = $2,
          running_since = NULL, request_id = NULL, last_heartbeat_at = NULL,
          retry_count = retry_count + 1, updated_at = NOW()
      WHERE id = $1
    `, [id, error])
  }

  // Records the cancellation intent (delivered to the worker on reconnect if it is
  // offline). Audit trail plus the basis for the cancel replay in the snapshot.
  async setCancelRequested(requestId: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs SET cancel_requested_at = NOW(), updated_at = NOW()
      WHERE request_id = $1
    `, [requestId])
  }

  // Cancellation confirmed: the job goes back to 'pending' with the normal cooldown
  // (reschedulable). 'cancelled' is terminal for the RUN only (analysis_runs); the
  // job does not die. Cancelling is NOT a failure — retry_count and 'dead' are untouched (§15.6).
  async releaseCancelled(requestId: string, nextRunAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'pending', running_since = NULL, request_id = NULL,
          last_heartbeat_at = NULL, cancel_requested_at = NULL, next_run_at = $2, updated_at = NOW()
      WHERE request_id = $1
    `, [requestId, nextRunAt])
  }

  // Snapshot of every job relevant to the Admin view (state + running time via
  // running_since). Running first, then the most recent.
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

  // Reclaims 'running' jobs by LEASE, not by a blind clock:
  // - lost: the lease expired (heartbeat stopped, or never arrived after the grace)
  //   → worker dead/unavailable. NOT a job failure → back to 'pending' with no
  //   penalty. A job still alive in the worker queue keeps heartbeating and is NOT
  //   reclaimed.
  // - hung: lease still held, but running past the absolute ceiling (the watchdog
  //   should have killed it) → a real failure: increments retry / becomes 'dead' at the limit.
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

  async countForRoutine(routineId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM scraping_jobs j WHERE ${belongsToRoutine('j', '= $1')}`,
      [routineId],
    )
    return Number(rows[0]?.count ?? 0)
  }

  async resetExclusiveToRoutine(routineId: string): Promise<ResetJobsResult> {
    // A job another routine also covers is left alone — the reset is scoped to
    // what only this routine reaches. A RUNNING job is left alone too: its worker
    // is mid-scrape and would report back against state we had just wiped.
    const { rowCount } = await this.db.query(
      `UPDATE scraping_jobs j
          SET status          = 'pending',
              retry_count     = 0,
              next_run_at     = NOW() + random() * ${SPREAD_WINDOW},
              last_success_at = NULL,
              last_failure_at = NULL,
              last_error      = NULL,
              running_since   = NULL,
              started_at      = NULL,
              last_heartbeat_at = NULL,
              request_id      = NULL,
              orphaned_at     = NULL,
              updated_at      = NOW()
        WHERE j.status <> 'running'
          AND ${belongsToRoutine('j', '= $1')}
          AND NOT ${belongsToRoutine('j', '<> $1')}`,
      [routineId],
    )

    const { rows } = await this.db.query<{ running: string; shared: string }>(
      `SELECT
         count(*) FILTER (WHERE j.status = 'running')                          AS running,
         count(*) FILTER (WHERE ${belongsToRoutine('j', '<> $1')})             AS shared
       FROM scraping_jobs j
       WHERE ${belongsToRoutine('j', '= $1')}`,
      [routineId],
    )
    return {
      reset:   rowCount ?? 0,
      running: Number(rows[0]?.running ?? 0),
      shared:  Number(rows[0]?.shared ?? 0),
    }
  }
}
