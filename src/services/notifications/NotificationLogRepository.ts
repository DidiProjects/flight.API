import { Pool } from 'pg'
import { NotificationLogRow } from '../../types'
import {
  INotificationLogRepository,
  InsertNotificationLogData,
} from './interfaces/INotificationLogRepository'

export class NotificationLogRepository implements INotificationLogRepository {
  constructor(private readonly db: Pool) {}

  async findLast(routineId: string, fareType: string): Promise<NotificationLogRow | null> {
    const { rows } = await this.db.query<NotificationLogRow>(
      `SELECT id, routine_id, type, fare_type, outbound_amount, return_amount,
              email_to, email_cc, sent_at
       FROM notification_log
       WHERE routine_id = $1 AND fare_type = $2
       ORDER BY sent_at DESC LIMIT 1`,
      [routineId, fareType],
    )
    return rows[0] ?? null
  }

  async insert(data: InsertNotificationLogData): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_log
         (routine_id, type, fare_type, outbound_amount, return_amount, email_to, email_cc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        data.routineId, data.type, data.fareType,
        data.outboundAmount, data.returnAmount,
        data.emailTo, data.emailCc,
      ],
    )
  }
}
