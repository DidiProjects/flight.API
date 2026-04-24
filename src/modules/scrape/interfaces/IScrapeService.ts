import { ScrapeCallback } from '../schema'

export interface IScrapeService {
  processCallback(data: ScrapeCallback): Promise<void>
}
