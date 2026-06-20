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
      -- Jobs com dono só "casam" com rotinas do mesmo usuário; jobs legados
      -- (user_id NULL) mantêm o casamento user-agnostic até expirarem.
      AND (j.user_id IS NULL OR r.user_id = j.user_id)
  )`

export class ScrapingJobRepository implements IScrapingJobRepository {
  constructor(private readonly db: Pool) {}

  async findRunningOrphans(): Promise<ScrapingJobRow[]> {
    const { rows } = await this.db.query<ScrapingJobRow>(
      `SELECT * FROM scraping_jobs j WHERE j.status = 'running' AND ${ORPHAN_PREDICATE}`,
    )
    return rows
  }

  async markOrphansDead(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE scraping_jobs j
          SET status = 'dead', running_since = NULL, request_id = NULL,
              last_error = 'Sem rotina ativa para esta rota', updated_at = NOW()
        WHERE j.status IN ('pending', 'failed', 'success')
          AND ${ORPHAN_PREDICATE}`,
    )
    return rowCount ?? 0
  }

  async upsertFromRoutines(): Promise<number> {
    const { rowCount } = await this.db.query(`
      INSERT INTO scraping_jobs (airline, origin, destination, flight_date, user_id)
      SELECT DISTINCT
        ra.airline,
        r.origin,
        r.destination,
        generate_series(r.outbound_start, r.outbound_end, '1 day'::interval)::date AS flight_date,
        r.user_id
      FROM routines r
      JOIN routine_airlines ra ON ra.routine_id = r.id
      WHERE r.is_active = true
        AND r.outbound_end >= CURRENT_DATE
      ON CONFLICT (airline, origin, destination, flight_date, user_id) DO NOTHING
    `)
    return rowCount ?? 0
  }

  async upsertFromRoutine(routineId: string): Promise<void> {
    await this.db.query(`
      INSERT INTO scraping_jobs (airline, origin, destination, flight_date, user_id)
      SELECT DISTINCT
        ra.airline,
        r.origin,
        r.destination,
        generate_series(r.outbound_start, r.outbound_end, '1 day'::interval)::date AS flight_date,
        r.user_id
      FROM routines r
      JOIN routine_airlines ra ON ra.routine_id = r.id
      WHERE r.id = $1
        AND r.outbound_end >= CURRENT_DATE
      ON CONFLICT (airline, origin, destination, flight_date, user_id) DO UPDATE
        SET next_run_at = NOW(),
            priority    = 100,
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
      SET status = 'running', running_since = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM scraping_jobs
        WHERE airline = $1
          AND status IN ('pending', 'failed', 'success')
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

  async markRunning(id: string, requestId: string): Promise<void> {
    await this.db.query(`
      UPDATE scraping_jobs
      SET request_id = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, requestId])
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
      SELECT j.*, u.email AS user_email,
             r.started_at AS run_started_at, r.finished_at AS run_finished_at
      FROM scraping_jobs j
      LEFT JOIN users u ON u.id = j.user_id
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

  async findOwnerEmailByRequestId(requestId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ email: string }>(
      `SELECT u.email
         FROM scraping_jobs j
         JOIN users u ON u.id = j.user_id
        WHERE j.request_id = $1`,
      [requestId],
    )
    return rows[0]?.email ?? null
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

  async recoverStuckJobs(): Promise<number> {
    const { rowCount } = await this.db.query(`
      UPDATE scraping_jobs
      SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead' ELSE 'pending' END,
          running_since = NULL, request_id = NULL,
          retry_count = retry_count + 1,
          last_error = CASE WHEN retry_count + 1 >= max_retries
                            THEN COALESCE(last_error, 'Stuck running: sem callback após timeout — max retries atingido')
                            ELSE last_error END,
          last_failure_at = CASE WHEN retry_count + 1 >= max_retries THEN NOW() ELSE last_failure_at END,
          next_run_at = NOW() + INTERVAL '2 minutes',
          updated_at = NOW()
      WHERE status = 'running'
        AND running_since < NOW() - (running_timeout_min || ' minutes')::interval
    `)
    return rowCount ?? 0
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
