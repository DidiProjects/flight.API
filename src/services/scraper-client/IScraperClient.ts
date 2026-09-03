/** One item of a batch: a date (one-way) or a date pair (round-trip). */
export interface ScrapeBatchItem {
  requestId: string
  jobId: string
  outboundDate: string
  /** Absent on one-way. */
  returnDate?: string
}

/**
 * A batch: items of ONE route and ONE airline, walked in series inside a single
 * browser session. Route, airline and passengers belong to the batch and not to the
 * item — that is exactly what lets the session be opened once.
 */
export interface ScrapeBatchDispatch {
  batchId: string
  airline: string
  origin: string
  destination: string
  passengers: number
  originCountry?: string
  destinationCountry?: string
  /** Time ceiling for the whole batch. Decided here so the number lives in one place. */
  deadlineMs: number
  items: ScrapeBatchItem[]
}

export interface IScraperClient {
  dispatchBatch(payload: ScrapeBatchDispatch): Promise<void>
}

// The scraper signalled a full queue (503). Not a job failure: the API should hold
// and try again, without incrementing retry or escalating to dead.
export class ScraperBusyError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('scraping.API queue full (503)')
    this.name = 'ScraperBusyError'
  }
}
