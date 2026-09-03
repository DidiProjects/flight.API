import { ScrapingJobRow } from '../../scraping-jobs/interfaces/IScrapingJobRepository'

/** Live = the worker still holds it. No item of a live batch may be claimed. */
export const LIVE_BATCH_STATUSES = ['dispatched', 'running', 'closing'] as const

export type BatchStatus =
  | 'dispatched'
  | 'running'
  | 'closing'
  | 'completed'
  | 'aborted'
  | 'superseded'
  | 'expired'

export type BatchTerminalStatus = Exclude<BatchStatus, 'dispatched' | 'running' | 'closing'>

export interface ScrapingBatchRow {
  id: string
  airline: string
  origin: string
  destination: string
  status: BatchStatus
  item_count: number
  received_count: number
  close_reason: string | null
  superseded_by: string | null
  attempt: number
  created_at: Date
  closed_at: Date | null
}

/** A batch and the jobs claimed into it, in the order the worker should walk them. */
export interface ClaimedBatch {
  batch: ScrapingBatchRow
  items: ScrapingJobRow[]
}

export interface IScrapingBatchRepository {
  /**
   * Claims up to `limit` eligible jobs of ONE route of this airline and opens a batch
   * with them, in a single transaction. The route is the one of the highest-priority
   * eligible job. Returns null when there is nothing to claim.
   */
  claimBatch(airline: string, limit: number, attempt?: number): Promise<ClaimedBatch | null>

  /** Same claim, narrowed to the route(s) of one routine — the manual dispatch path. */
  claimBatchForRoutine(routineId: string, limit: number): Promise<ClaimedBatch | null>

  findById(id: string): Promise<ScrapingBatchRow | null>
  findLiveByRoute(airline: string, origin: string, destination: string): Promise<ScrapingBatchRow | null>
  /** Live batches on the routes a routine covers — the supersede scope. */
  findLiveForRoutine(routineId: string): Promise<ScrapingBatchRow[]>
  listItems(batchId: string): Promise<ScrapingJobRow[]>

  markRunning(id: string): Promise<void>
  /** One more item callback landed. Returns the batch as it stands after the increment. */
  registerReceived(id: string): Promise<ScrapingBatchRow | null>
  /** An item left the batch (cancelled): the batch now expects one item less. */
  dropItem(id: string): Promise<ScrapingBatchRow | null>

  markClosing(id: string, reason: string): Promise<void>
  close(id: string, status: BatchTerminalStatus, reason: string): Promise<ScrapingBatchRow | null>
  markSuperseded(id: string, supersededBy: string | null): Promise<void>

  countLive(): Promise<number>
  countLiveByAirline(airline: string): Promise<number>
  /** Live batches older than `maxRunMin` — the backstop of the closing rules. */
  findLiveOlderThan(maxRunMin: number): Promise<ScrapingBatchRow[]>
  /** Closes every live batch of an airline. Used when a block pauses the airline. */
  closeLiveByAirline(airline: string, reason: string): Promise<ScrapingBatchRow[]>
}
