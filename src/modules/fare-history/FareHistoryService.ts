import { IFareHistoryService } from './interfaces/IFareHistoryService'
import {
  FareHistoryQuery,
  FareHistoryRange,
  FareHistorySeries,
  IFareHistoryRepository,
} from './interfaces/IFareHistoryRepository'

export class FareHistoryService implements IFareHistoryService {
  constructor(private readonly repo: IFareHistoryRepository) {}

  getSeries(query: FareHistoryQuery, range: FareHistoryRange): Promise<FareHistorySeries> {
    return this.repo.getSeries(query, range)
  }
}
