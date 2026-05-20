import { RoutineRow } from '../../../types'

export interface INotificationsService {
  evaluate(routine: RoutineRow): Promise<void>
  sendEndOfPeriod(): Promise<void>
  sendDailyBest(): Promise<void>
}
