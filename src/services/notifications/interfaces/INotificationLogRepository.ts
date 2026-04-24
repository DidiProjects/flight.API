import { NotificationLogRow } from '../../../types'

export interface InsertNotificationLogData {
  routineId: string
  type: 'alert' | 'best_of_day' | 'end_of_period'
  fareType: string
  outboundAmount: number | null
  returnAmount: number | null
  emailTo: string
  emailCc: string | null
}

export interface INotificationLogRepository {
  findLast(routineId: string, fareType: string): Promise<NotificationLogRow | null>
  insert(data: InsertNotificationLogData): Promise<void>
}
