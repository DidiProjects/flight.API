import { FlightOfferRow, RoutineRow } from '../../../types'

export interface INotificationsService {
  evaluate(routine: RoutineRow, offers: FlightOfferRow[]): Promise<void>
  sendEndOfPeriod(): Promise<void>
  sendDailyBest(): Promise<void>
}
