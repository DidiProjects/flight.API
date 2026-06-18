export type AnalysisRunStatus = 'running' | 'success' | 'failed' | 'dead' | 'blocked'

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
  returnStart: string | null
  returnEnd: string | null
  limit?: number
}

export interface IAnalysisRunsRepository {
  insertRunning(data: InsertRunningData): Promise<void>
  markFinished(requestId: string, data: MarkFinishedData): Promise<void>
  listByRoutineMatch(params: RoutineMatchParams): Promise<AnalysisRunRow[]>
  cleanupOlderThan(days: number): Promise<number>
}
