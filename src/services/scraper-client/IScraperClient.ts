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

// Scraper sinalizou fila cheia (503). Não é falha do job: a API deve segurar e
// tentar de novo, sem incrementar retry nem escalar para dead.
export class ScraperBusyError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('scraping.API queue full (503)')
    this.name = 'ScraperBusyError'
  }
}
