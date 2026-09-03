import { Env } from '../../config/env'
import { IScraperClient, ScrapeBatchDispatch, ScraperBusyError } from './IScraperClient'

const DISPATCH_TIMEOUT_MS = 10_000

export class HttpScraperClient implements IScraperClient {
  constructor(private readonly env: Env) {}

  async dispatchBatch(payload: ScrapeBatchDispatch): Promise<void> {
    const res = await fetch(`${this.env.SCRAPING_API_URL}/scrape/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.env.SCRAPING_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (res.status === 503) {
      const data = await res.json().catch(() => ({})) as { retryAfterMs?: number }
      throw new ScraperBusyError(typeof data.retryAfterMs === 'number' ? data.retryAfterMs : 60_000)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`scraping.API ${res.status}: ${body}`)
    }
  }
}
