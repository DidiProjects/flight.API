import { Pool } from 'pg'
import {
  AnalysisRunRow,
  IAnalysisRunsRepository,
  InsertRunningData,
  MarkFinishedData,
  RoutineMatchParams,
} from './interfaces/IAnalysisRunsRepository'

const RUN_COLS = `id, scraping_job_id, request_id, airline, origin, destination, flight_date,
                  status, error_message, fares_found, started_at, finished_at`

export class AnalysisRunsRepository implements IAnalysisRunsRepository {
  constructor(private readonly db: Pool) {}

  async insertRunning(data: InsertRunningData): Promise<void> {
    await this.db.query(
      `INSERT INTO analysis_runs
         (scraping_job_id, request_id, airline, origin, destination, flight_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'running')`,
      [data.jobId, data.requestId, data.airline, data.origin, data.destination, data.flightDate],
    )
  }

  async markFinished(requestId: string, data: MarkFinishedData): Promise<void> {
    await this.db.query(
      `UPDATE analysis_runs
          SET status = $2, fares_found = $3, error_message = $4, finished_at = now()
        WHERE request_id = $1 AND status = 'running'`,
      [requestId, data.status, data.faresFound ?? null, data.errorMessage ?? null],
    )
  }

  async listByRoutineMatch(params: RoutineMatchParams): Promise<AnalysisRunRow[]> {
    const { airlines, origin, destination, outboundStart, outboundEnd, returnStart, returnEnd, limit = 200 } = params
    const hasReturn = returnStart != null && returnEnd != null

    const { rows } = await this.db.query<AnalysisRunRow>(
      `SELECT ${RUN_COLS}
       FROM analysis_runs
       WHERE airline = ANY($1::text[])
         AND (
           (origin = $2 AND destination = $3 AND flight_date BETWEEN $4 AND $5)
           ${hasReturn ? 'OR (origin = $3 AND destination = $2 AND flight_date BETWEEN $6 AND $7)' : ''}
         )
       ORDER BY started_at DESC
       LIMIT ${hasReturn ? '$8' : '$6'}`,
      hasReturn
        ? [airlines, origin, destination, outboundStart, outboundEnd, returnStart, returnEnd, limit]
        : [airlines, origin, destination, outboundStart, outboundEnd, limit],
    )
    return rows
  }

  async failStaleRunning(timeoutMin: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE analysis_runs
          SET status = 'failed',
              error_message = COALESCE(error_message, 'Sem retorno do scraper (timeout)'),
              finished_at = now()
        WHERE status = 'running'
          AND started_at < now() - ($1 || ' minutes')::interval`,
      [timeoutMin],
    )
    return rowCount ?? 0
  }

  async cleanupOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM analysis_runs WHERE started_at < now() - ($1 || ' days')::interval`,
      [days],
    )
    return rowCount ?? 0
  }
}
