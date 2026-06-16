import { Pool } from 'pg'
import { IScrapingJobRepository, ScrapingJobRow } from './interfaces/IScrapingJobRepository'

export class ScrapingJobRepository implements IScrapingJobRepository {
  constructor(private readonly db: Pool) {}

  async upsertFromRoutines(): Promise<number> {
    const { rowCount } = await this.db.query(`
      INSERT INTO scraping_jobs (airline, origin, destination, flight_date)
      SELECT DISTINCT
        ra.airline,
        r.origin,
        r.destination,
        generate_series(r.outbound_start, r.outbound_end, '1 day'::interval)::date AS flight_date
      FROM routines r
      JOIN routine_airlines ra ON ra.routine_id = r.id
      WHERE r.is_active = true
        AND r.outbound_end >= CURRENT_DATE
      UNION
      SELECT DISTINCT
        ra.airline,
        r.origin,
        r.destination,
        generate_series(r.return_start, r.return_end, '1 day'::interval)::date AS flight_date
      FROM routines r
      JOIN routine_airlines ra ON ra.routine_id = r.id
      WHERE r.is_active = true
        AND r.return_start IS NOT NULL
        AND r.return_end IS NOT NULL
        AND r.return_end >= CURRENT_DATE
      ON CONFLICT (airline, origin, destination, flight_date) DO NOTHING
    `)
    return rowCount ?? 0
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
          AND status IN ('pending', 'failed')
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
          request_id = NULL, retry_count = 0, next_run_at = $2, updated_at = NOW()
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

  async recoverStuckJobs(): Promise<number> {
    const { rowCount } = await this.db.query(`
      UPDATE scraping_jobs
      SET status = 'pending', running_since = NULL, request_id = NULL,
          retry_count = retry_count + 1, next_run_at = NOW() + INTERVAL '2 minutes',
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

  async getActiveAirlines(): Promise<string[]> {
    const { rows } = await this.db.query<{ airline: string }>(`
      SELECT DISTINCT airline FROM scraping_jobs
      WHERE status IN ('pending', 'failed')
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
