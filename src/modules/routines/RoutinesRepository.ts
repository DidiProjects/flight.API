import { Pool } from 'pg'
import { RoutineRow } from '../../types'
import { IRoutinesRepository, CreateRoutineData } from './interfaces/IRoutinesRepository'

const COLS = `
  id, user_id, name, airline, origin, destination,
  outbound_start, outbound_end, return_start, return_end, passengers,
  target_brl, target_pts, target_hyb_pts, target_hyb_brl,
  margin, priority, notification_mode, notification_frequency, end_of_period_time,
  cc_emails, pending_request_id, pending_request_at, is_active, created_at, updated_at`

export class RoutinesRepository implements IRoutinesRepository {
  constructor(private readonly db: Pool) {}

  async findByUser(userId: string): Promise<RoutineRow[]> {
    const { rows } = await this.db.query<RoutineRow>(
      `SELECT ${COLS} FROM routines WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    )
    return rows
  }

  async findById(id: string, userId: string): Promise<RoutineRow | null> {
    const { rows } = await this.db.query<RoutineRow>(
      `SELECT ${COLS} FROM routines WHERE id = $1 AND user_id = $2`,
      [id, userId],
    )
    return rows[0] ?? null
  }

  async findByIdAdmin(id: string): Promise<RoutineRow | null> {
    const { rows } = await this.db.query<RoutineRow>(
      `SELECT ${COLS} FROM routines WHERE id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  async countByUser(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM routines WHERE user_id = $1`,
      [userId],
    )
    return parseInt(rows[0].count)
  }

  async findDispatchable(): Promise<RoutineRow[]> {
    const { rows } = await this.db.query<RoutineRow>(
      `SELECT ${COLS} FROM routines
       WHERE is_active = true
         AND (pending_request_id IS NULL OR pending_request_at < now() - INTERVAL '1 hour')`,
    )
    return rows
  }

  async findActiveForEndOfPeriod(currentTime: string): Promise<RoutineRow[]> {
    const { rows } = await this.db.query<RoutineRow>(
      `SELECT ${COLS} FROM routines
       WHERE is_active = true
         AND notification_mode = 'end_of_period'
         AND to_char(end_of_period_time, 'HH24:MI') = $1`,
      [currentTime],
    )
    return rows
  }

  async findActiveForDailyBest(): Promise<RoutineRow[]> {
    const { rows } = await this.db.query<RoutineRow>(
      `SELECT ${COLS} FROM routines
       WHERE is_active = true AND notification_mode = 'daily_best_and_alert'`,
    )
    return rows
  }

  async create(data: CreateRoutineData): Promise<RoutineRow> {
    const ccJson = JSON.stringify(data.ccEmails.map((e) => ({ email: e, subscribed: true })))
    const { rows } = await this.db.query<RoutineRow>(
      `INSERT INTO routines (
         user_id, name, airline, origin, destination,
         outbound_start, outbound_end, return_start, return_end, passengers,
         target_brl, target_pts, target_hyb_pts, target_hyb_brl,
         margin, priority, notification_mode, notification_frequency, end_of_period_time, cc_emails, is_active
       ) VALUES (
         $1,$2,$3,$4,$5, $6,$7,$8,$9,$10,
         $11,$12,$13,$14, $15,$16,$17,$18,$19,$20,$21
       ) RETURNING ${COLS}`,
      [
        data.userId, data.name, data.airline, data.origin, data.destination,
        data.outboundStart, data.outboundEnd, data.returnStart ?? null, data.returnEnd ?? null, data.passengers,
        data.targetBrl ?? null, data.targetPts ?? null, data.targetHybPts ?? null, data.targetHybBrl ?? null,
        data.margin, data.priority, data.notificationMode, data.notificationFrequency,
        data.endOfPeriodTime ?? null, ccJson, data.isActive ?? true,
      ],
    )
    return rows[0]
  }

  async update(id: string, userId: string, fields: Partial<CreateRoutineData>): Promise<RoutineRow | null> {
    const colMap: Record<string, string> = {
      name: 'name', airline: 'airline', origin: 'origin', destination: 'destination',
      outboundStart: 'outbound_start', outboundEnd: 'outbound_end',
      returnStart: 'return_start', returnEnd: 'return_end', passengers: 'passengers',
      targetBrl: 'target_brl', targetPts: 'target_pts',
      targetHybPts: 'target_hyb_pts', targetHybBrl: 'target_hyb_brl',
      margin: 'margin', priority: 'priority',
      notificationMode: 'notification_mode', notificationFrequency: 'notification_frequency',
      endOfPeriodTime: 'end_of_period_time', isActive: 'is_active',
    }
    const updates: string[] = []
    const values: unknown[] = []
    let i = 1
    for (const [key, col] of Object.entries(colMap)) {
      if (key in fields) { updates.push(`${col} = $${i++}`); values.push((fields as Record<string, unknown>)[key] ?? null) }
    }
    if ('ccEmails' in fields && fields.ccEmails) {
      updates.push(`cc_emails = $${i++}`)
      values.push(JSON.stringify(fields.ccEmails.map((e) => ({ email: e, subscribed: true }))))
    }
    if (updates.length === 0) return this.findById(id, userId)
    updates.push(`updated_at = now()`)
    values.push(id, userId)
    const { rows } = await this.db.query<RoutineRow>(
      `UPDATE routines SET ${updates.join(', ')} WHERE id = $${i} AND user_id = $${i + 1} RETURNING ${COLS}`,
      values,
    )
    return rows[0] ?? null
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM routines WHERE id = $1 AND user_id = $2`,
      [id, userId],
    )
    return (rowCount ?? 0) > 0
  }

  async deleteAdmin(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM routines WHERE id = $1`,
      [id],
    )
    return (rowCount ?? 0) > 0
  }

  async setActive(id: string, userId: string, active: boolean): Promise<RoutineRow | null> {
    const { rows } = await this.db.query<RoutineRow>(
      `UPDATE routines SET is_active = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3 RETURNING ${COLS}`,
      [active, id, userId],
    )
    return rows[0] ?? null
  }

  async setActiveAdmin(id: string, active: boolean): Promise<RoutineRow | null> {
    const { rows } = await this.db.query<RoutineRow>(
      `UPDATE routines SET is_active = $1, updated_at = now()
       WHERE id = $2 RETURNING ${COLS}`,
      [active, id],
    )
    return rows[0] ?? null
  }

  async setPendingRequest(id: string, requestId: string): Promise<void> {
    await this.db.query(
      `UPDATE routines SET pending_request_id = $1, pending_request_at = now(), updated_at = now()
       WHERE id = $2`,
      [requestId, id],
    )
  }

  async deactivateByAirline(airlineCode: string): Promise<void> {
    await this.db.query(
      `UPDATE routines SET is_active = false, updated_at = now() WHERE airline = $1 AND is_active = true`,
      [airlineCode],
    )
  }

  async clearPendingRequest(id: string): Promise<void> {
    await this.db.query(
      `UPDATE routines SET pending_request_id = NULL, pending_request_at = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    )
  }
}
