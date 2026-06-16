import { RoutineRow } from '../../../types'
import { LatestFaresByDate, PriceHistory } from '../../../modules/flight-fares/interfaces/IFlightFaresRepository'

export interface INotificationsService {
  evaluate(routine: RoutineRow): Promise<void>
  sendScheduled(): Promise<void>
  hasRecentAlert(routineId: string, hours: number): Promise<boolean>
  dispatchAlert(routine: RoutineRow, outboundFare: LatestFaresByDate, returnFare: LatestFaresByDate | null, history: PriceHistory): Promise<void>
}
