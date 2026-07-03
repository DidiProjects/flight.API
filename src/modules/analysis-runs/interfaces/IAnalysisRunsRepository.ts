export type AnalysisRunStatus = 'running' | 'success' | 'failed' | 'dead' | 'blocked' | 'cancelled'

export type AnalysisRunEventType = 'queued' | 'started' | 'progress' | 'log' | 'finished'
export type AnalysisRunEventLevel = 'info' | 'warn' | 'error'

export interface AnalysisRunRow {
  id: string
  scraping_job_id: string | null
  request_id: string
  airline: string
  origin: string
  destination: string
  flight_date: string
  status: AnalysisRunStatus
  error_message: string | null
  fares_found: number | null
  started_at: Date
  finished_at: Date | null
}

export interface AnalysisRunEventRow {
  id: string
  request_id: string
  seq: number
  ts: Date
  type: AnalysisRunEventType
  level: AnalysisRunEventLevel | null
  payload: Record<string, unknown>
}

export interface AppendEventData {
  requestId: string
  seq: number
  type: AnalysisRunEventType
  level?: AnalysisRunEventLevel | null
  payload?: Record<string, unknown>
}

export interface InsertRunningData {
  jobId: string
  requestId: string
  airline: string
  origin: string
  destination: string
  flightDate: string
}

export interface MarkFinishedData {
  status: AnalysisRunStatus
  faresFound?: number | null
  errorMessage?: string | null
}

export interface RoutineMatchParams {
  airlines: string[]
  origin: string
  destination: string
  outboundStart: string
  outboundEnd: string
  limit?: number
}

export interface IAnalysisRunsRepository {
  insertRunning(data: InsertRunningData): Promise<void>
  markFinished(requestId: string, data: MarkFinishedData): Promise<void>
  resetStartedAt(requestId: string): Promise<void>
  listByRoutineMatch(params: RoutineMatchParams): Promise<AnalysisRunRow[]>
  failStaleRunning(timeoutMin: number): Promise<number>
  cleanupOlderThan(days: number): Promise<number>
  appendEvent(data: AppendEventData): Promise<void>
  setCancelledBy(requestId: string, userId: string): Promise<void>
  markCancelled(requestId: string): Promise<void>
  listEvents(requestId: string): Promise<AnalysisRunEventRow[]>
  listEventsByJobId(jobId: string): Promise<AnalysisRunEventRow[]>
  cleanupEventsOlderThan(days: number): Promise<number>
}
