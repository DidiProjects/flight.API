import { BatchCallback, ScrapeCallback } from '../schema'

export interface IScrapeService {
  processCallback(data: ScrapeCallback): Promise<void>
  /** The batch came back whole: only now do its failed items get a fate. */
  processBatchCallback(data: BatchCallback): Promise<void>
}
