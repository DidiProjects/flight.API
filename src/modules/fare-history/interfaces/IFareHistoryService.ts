import { FareHistoryQuery, FareHistoryRange, FareHistorySeries } from './IFareHistoryRepository'

export interface IFareHistoryService {
  /** Best price over time for a routine's route and windows, bucketed by range. */
  getSeries(query: FareHistoryQuery, range: FareHistoryRange): Promise<FareHistorySeries>
}
