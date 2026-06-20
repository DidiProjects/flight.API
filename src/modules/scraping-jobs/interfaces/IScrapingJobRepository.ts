export interface ScrapingJobRow {
  id: string
  airline: string
  origin: string
  destination: string
  flight_date: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'dead' | 'cancelled'
  priority: number
  retry_count: number
  max_retries: number
  next_run_at: Date
  last_success_at: Date | null
  last_failure_at: Date | null
  last_error: string | null
  running_since: Date | null
  running_timeout_min: number
  request_id: string | null
  cancel_requested_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface AdminJobRow extends ScrapingJobRow {
  run_started_at: Date | null
  run_finished_at: Date | null
}

export interface IScrapingJobRepository {
  upsertFromRoutines(): Promise<number>
  upsertFromRoutine(routineId: string): Promise<void>
  expireOldJobs(): Promise<number>
  updatePriorities(): Promise<void>
  claimNextJob(airline: string): Promise<ScrapingJobRow | null>
  markRunning(id: string, requestId: string): Promise<void>
  markSuccess(id: string, nextRunAt: Date): Promise<void>
  markFailed(id: string, error: string, nextRunAt: Date): Promise<void>
  markDead(id: string, error: string): Promise<void>
  pauseAirlineForBlock(airline: string, until: Date, error: string): Promise<number>
  recoverStuckJobs(): Promise<number>
  findByRequestId(requestId: string): Promise<ScrapingJobRow | null>
  findById(id: string): Promise<ScrapingJobRow | null>
  getActiveAirlines(): Promise<string[]>
  cleanupDeadJobs(): Promise<number>
  setCancelRequested(requestId: string): Promise<void>
  releaseCancelled(requestId: string, nextRunAt: Date): Promise<void>
  listForAdmin(limit?: number): Promise<AdminJobRow[]>
}
