import { RoutineRow } from '../../../types'

export interface INotificationsService {
  evaluate(routine: RoutineRow): Promise<void>
  sendScheduled(): Promise<void>
}
