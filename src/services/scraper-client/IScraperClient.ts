export interface ScrapeDispatch {
  requestId: string
  routineId: string
  airline: string
  origin: string
  destination: string
  outboundStart: string
  outboundEnd: string
  passengers: number
  originCountry?: string
  destinationCountry?: string
}

export interface IScraperClient {
  dispatch(payload: ScrapeDispatch): Promise<void>
}

// The scraper signalled a full queue (503). Not a job failure: the API should hold
// and try again, without incrementing retry or escalating to dead.
export class ScraperBusyError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('scraping.API queue full (503)')
    this.name = 'ScraperBusyError'
  }
}
