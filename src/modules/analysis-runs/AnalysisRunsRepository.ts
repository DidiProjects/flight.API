import { Pool } from 'pg'
import {
  AnalysisRunRow,
  AnalysisRunEventRow,
  AppendEventData,
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

  // Timeline append-only. Idempotente por (request_id, seq): telemetria é
  // best-effort e pode reentregar na reconexão — duplicados são ignorados.
  async appendEvent(data: AppendEventData): Promise<void> {
    await this.db.query(
      `INSERT INTO analysis_run_events (request_id, seq, type, level, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id, seq) DO NOTHING`,
      [data.requestId, data.seq, data.type, data.level ?? null, JSON.stringify(data.payload ?? {})],
    )
  }

  // Registra quem pediu o cancelamento (no momento do pedido, mesmo que a entrega
  // ao worker seja diferida). Não muda o status.
  async setCancelledBy(requestId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE analysis_runs SET cancelled_by = $2
        WHERE request_id = $1 AND status = 'running'`,
      [requestId, userId],
    )
  }

  // Confirmação do cancelamento (chega via telemetria job.finished cancelled).
  async markCancelled(requestId: string): Promise<void> {
    await this.db.query(
      `UPDATE analysis_runs
          SET status = 'cancelled', finished_at = now()
        WHERE request_id = $1 AND status = 'running'`,
      [requestId],
    )
  }

  async listEvents(requestId: string): Promise<AnalysisRunEventRow[]> {
    const { rows } = await this.db.query<AnalysisRunEventRow>(
      `SELECT id, request_id, seq, ts, type, level, payload
         FROM analysis_run_events
        WHERE request_id = $1
        ORDER BY seq ASC`,
      [requestId],
    )
    return rows
  }

  async cleanupEventsOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM analysis_run_events WHERE ts < now() - ($1 || ' days')::interval`,
      [days],
    )
    return rowCount ?? 0
  }

  async listByRoutineMatch(params: RoutineMatchParams): Promise<AnalysisRunRow[]> {
    const { airlines, origin, destination, outboundStart, outboundEnd, limit = 200 } = params

    const { rows } = await this.db.query<AnalysisRunRow>(
      `SELECT ${RUN_COLS}
       FROM analysis_runs
       WHERE airline = ANY($1::text[])
         AND origin = $2 AND destination = $3
         AND flight_date BETWEEN $4 AND $5
       ORDER BY started_at DESC
       LIMIT $6`,
      [airlines, origin, destination, outboundStart, outboundEnd, limit],
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
