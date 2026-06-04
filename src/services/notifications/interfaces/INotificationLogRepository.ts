import { NotificationLogRow } from '../../../types'

export interface InsertNotificationLogData {
  routineId: string
  airline: string
  type: 'alert' | 'best_of_day' | 'scheduled'
  fareType: string
  outboundAmount: number | null
  returnAmount: number | null
  emailTo: string
  emailCc: string | null
}

export interface INotificationLogRepository {
  findLast(routineId: string, fareType: string, airline: string): Promise<NotificationLogRow | null>
  findLastByType(routineId: string, fareType: string, type: string, airline: string): Promise<NotificationLogRow | null>
  hasAlertSince(routineId: string, fareType: string, since: Date): Promise<boolean>
  insert(data: InsertNotificationLogData): Promise<void>
}
