export interface ScrapingJobRow {
  id: string
  airline: string
  origin: string
  destination: string
  flight_date: string
  /** Filled = round-trip job (RT search with both dates). NULL = one-way. */
  return_date: string | null
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
  started_at: Date | null
  request_id: string | null
  cancel_requested_at: Date | null
  orphaned_at: Date | null
  /** Live batch holding this item; NULL = outside a batch. */
  batch_id: string | null
  created_at: Date
  updated_at: Date
}

export interface AdminJobRow extends ScrapingJobRow {
  user_emails: string[]
  run_started_at: Date | null
  run_finished_at: Date | null
}

export interface SettleBatchItemOptions {
  /** Counts one retry against the item. False for block, supersede and never-attempted. */
  penalise: boolean
  nextRunAt: Date
  error?: string | null
}

/** Balance of the reset: what went back to zero and what was preserved, and why. */
export interface ResetJobsResult {
  reset: number
  /** Running jobs — the worker is mid-scrape, they are left alone. */
  running: number
  /** Jobs another routine also covers — the data is not this routine's alone. */
  shared: number
}

export interface IScrapingJobRepository {
  upsertFromRoutines(): Promise<number>
  upsertFromRoutine(routineId: string): Promise<void>
  expireOldJobs(): Promise<number>
  updatePriorities(): Promise<void>
  countInFlight(): Promise<number>
  countInFlightByAirline(airline: string): Promise<number>
  deferJob(id: string, nextRunAt: Date): Promise<void>
  markRunning(id: string, requestId: string): Promise<void>
  markStarted(requestId: string): Promise<void>
  markHeartbeat(requestIds: string[]): Promise<void>
  markSuccess(id: string, nextRunAt: Date): Promise<void>
  markFailed(id: string, error: string, nextRunAt: Date): Promise<void>
  markDead(id: string, error: string): Promise<void>
  markSiteError(id: string, error: string, nextRunAt: Date): Promise<void>
  /**
   * An item of a LIVE batch failed. Records the error and frees the lease, but touches
   * neither `retry_count` nor `next_run_at` and keeps `batch_id`: what happens to a
   * failed item is decided when the batch closes, together with its siblings. That is
   * "an operation in a batch is always handled as a batch" — without it the item would
   * come back on its own a minute later (`calcBackoffNextRunAt`, 60s base) and spend a
   * whole browser session on one item.
   */
  holdForBatch(id: string, error: string): Promise<void>
  /** Releases an item from a closed batch, with or without counting a retry. */
  settleBatchItem(id: string, opts: SettleBatchItemOptions): Promise<void>
  pauseAirlineForBlock(airline: string, until: Date, error: string): Promise<number>
  reclaimExpiredJobs(leaseTimeoutSec: number, graceSec: number, maxRunMin: number): Promise<{ lost: string[]; hung: string[] }>
  findByRequestId(requestId: string): Promise<ScrapingJobRow | null>
  findById(id: string): Promise<ScrapingJobRow | null>
  getActiveAirlines(): Promise<string[]>
  cleanupDeadJobs(): Promise<number>
  setCancelRequested(requestId: string): Promise<void>
  releaseCancelled(requestId: string, nextRunAt: Date): Promise<void>
  listForAdmin(limit?: number): Promise<AdminJobRow[]>
  findOwnerEmailsByRequestId(requestId: string): Promise<string[]>
  findRunningOrphans(): Promise<ScrapingJobRow[]>
  retireOrphans(): Promise<number>
  countForRoutine(routineId: string): Promise<number>
  resetExclusiveToRoutine(routineId: string): Promise<ResetJobsResult>
}
