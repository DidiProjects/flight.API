import { Pool } from 'pg'
import { RoutineRow } from '../../types'
import { IRoutinesRepository, CreateRoutineData } from './interfaces/IRoutinesRepository'

const ROUTINE_COLS = `
  r.id, r.user_id, r.name, r.origin, r.destination,
  r.outbound_start, r.outbound_end, r.return_start, r.return_end, r.passengers,
  r.currency, r.target_cash, r.target_pts, r.target_hyb_pts, r.target_hyb_cash,
  r.margin, r.priority, r.notification_modes, r.notification_frequency, r.scheduled_time,
  r.cc_emails, r.is_active, r.created_at, r.updated_at`

/** Build a SELECT that includes the aggregated airlines array */
function selectWithAirlines(whereClause: string, groupBy = 'r.id'): string {
  return `
    SELECT ${ROUTINE_COLS},
      COALESCE(ARRAY_AGG(ra.airline ORDER BY ra.airline) FILTER (WHERE ra.airline IS NOT NULL), '{}') AS airlines
    FROM routines r
    LEFT JOIN routine_airlines ra ON ra.routine_id = r.id
    ${whereClause}
    GROUP BY ${groupBy}`
}

export class RoutinesRepository implements IRoutinesRepository {
  constructor(private readonly db: Pool) {}

  async findByUser(userId: string): Promise<RoutineRow[]> {
    const { rows } = await this.db.query<RoutineRow>(
      `${selectWithAirlines('WHERE r.user_id = $1')} ORDER BY r.created_at DESC`,
      [userId],
    )
    return rows
  }

  async findById(id: string, userId: string): Promise<RoutineRow | null> {
    const { rows } = await this.db.query<RoutineRow>(
      selectWithAirlines('WHERE r.id = $1 AND r.user_id = $2'),
      [id, userId],
    )
    return rows[0] ?? null
  }

  async findByIdAdmin(id: string): Promise<RoutineRow | null> {
    const { rows } = await this.db.query<RoutineRow>(
      selectWithAirlines('WHERE r.id = $1'),
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
      `SELECT ${ROUTINE_COLS},
        COALESCE(ARRAY_AGG(ra.airline ORDER BY ra.airline) FILTER (
          WHERE rpr.request_id IS NULL OR rpr.requested_at < now() - INTERVAL '1 hour'
        ), '{}') AS airlines
       FROM routines r
       JOIN routine_airlines ra ON ra.routine_id = r.id
       LEFT JOIN routine_pending_requests rpr ON rpr.routine_id = r.id AND rpr.airline = ra.airline
       WHERE r.is_active = true
       GROUP BY r.id
       HAVING COUNT(ra.airline) FILTER (
         WHERE rpr.request_id IS NULL OR rpr.requested_at < now() - INTERVAL '1 hour'
       ) > 0`,
    )
    return rows
  }

  async findAllActive(): Promise<RoutineRow[]> {
    const { rows } = await this.db.query<RoutineRow>(
      selectWithAirlines('WHERE r.is_active = true'),
    )
    return rows
  }

  async findActiveForScheduled(currentTime: string): Promise<RoutineRow[]> {
    const { rows } = await this.db.query<RoutineRow>(
      `${selectWithAirlines(`WHERE r.is_active = true
         AND 'scheduled' = ANY(r.notification_modes)
         AND to_char(r.scheduled_time, 'HH24:MI') = $1`)}`,
      [currentTime],
    )
    return rows
  }

  async create(data: CreateRoutineData): Promise<RoutineRow> {
    const client = await this.db.connect()
    try {
      await client.query('BEGIN')
      const ccJson = JSON.stringify(data.ccEmails.map((e) => ({ email: e, subscribed: true })))
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO routines (
           user_id, name, origin, destination,
           outbound_start, outbound_end, return_start, return_end, passengers,
           currency, target_cash, target_pts, target_hyb_pts, target_hyb_cash,
           margin, priority, notification_modes, notification_frequency, scheduled_time, cc_emails, is_active
         ) VALUES (
           $1,$2,$3,$4, $5,$6,$7,$8,$9,
           $10,$11,$12,$13,$14, $15,$16,$17,$18,$19,$20,$21
         ) RETURNING id`,
        [
          data.userId, data.name, data.origin, data.destination,
          data.outboundStart, data.outboundEnd, data.returnStart ?? null, data.returnEnd ?? null, data.passengers,
          data.currency, data.targetCash ?? null, data.targetPts ?? null, data.targetHybPts ?? null, data.targetHybCash ?? null,
          data.margin, data.priority, data.notificationModes, data.notificationFrequency,
          data.scheduledTime ?? null, ccJson, data.isActive ?? true,
        ],
      )
      const routineId = rows[0].id
      for (const airline of data.airlines) {
        await client.query(
          `INSERT INTO routine_airlines (routine_id, airline) VALUES ($1, $2)`,
          [routineId, airline],
        )
      }
      await client.query('COMMIT')

      const routine = await this.findByIdAdmin(routineId)
      return routine!
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async update(id: string, userId: string, fields: Partial<CreateRoutineData>): Promise<RoutineRow | null> {
    const colMap: Record<string, string> = {
      name: 'name', origin: 'origin', destination: 'destination',
      outboundStart: 'outbound_start', outboundEnd: 'outbound_end',
      returnStart: 'return_start', returnEnd: 'return_end', passengers: 'passengers',
      currency: 'currency',
      targetCash: 'target_cash', targetPts: 'target_pts',
      targetHybPts: 'target_hyb_pts', targetHybCash: 'target_hyb_cash',
      margin: 'margin', priority: 'priority',
      notificationModes: 'notification_modes', notificationFrequency: 'notification_frequency',
      scheduledTime: 'scheduled_time', isActive: 'is_active',
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

    const hasAirlines = 'airlines' in fields && Array.isArray(fields.airlines)
    const hasScalarUpdates = updates.length > 0

    if (!hasScalarUpdates && !hasAirlines) return this.findById(id, userId)

    const client = await this.db.connect()
    try {
      await client.query('BEGIN')

      if (hasScalarUpdates) {
        updates.push(`updated_at = now()`)
        const idIdx = i++
        const userIdx = i++
        values.push(id, userId)
        const { rowCount } = await client.query(
          `UPDATE routines SET ${updates.join(', ')} WHERE id = $${idIdx} AND user_id = $${userIdx}`,
          values,
        )
        if ((rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return null
        }
      }

      if (hasAirlines && fields.airlines) {
        // Verify ownership
        const { rowCount } = await client.query(
          `SELECT 1 FROM routines WHERE id = $1 AND user_id = $2`,
          [id, userId],
        )
        if ((rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return null
        }
        await client.query(`DELETE FROM routine_airlines WHERE routine_id = $1`, [id])
        for (const airline of fields.airlines) {
          await client.query(
            `INSERT INTO routine_airlines (routine_id, airline) VALUES ($1, $2)`,
            [id, airline],
          )
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return this.findById(id, userId)
  }

  async updateById(id: string, fields: Partial<CreateRoutineData>): Promise<RoutineRow | null> {
    const colMap: Record<string, string> = {
      name: 'name', origin: 'origin', destination: 'destination',
      outboundStart: 'outbound_start', outboundEnd: 'outbound_end',
      returnStart: 'return_start', returnEnd: 'return_end', passengers: 'passengers',
      currency: 'currency',
      targetCash: 'target_cash', targetPts: 'target_pts',
      targetHybPts: 'target_hyb_pts', targetHybCash: 'target_hyb_cash',
      margin: 'margin', priority: 'priority',
      notificationModes: 'notification_modes', notificationFrequency: 'notification_frequency',
      scheduledTime: 'scheduled_time', isActive: 'is_active',
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

    const hasAirlines = 'airlines' in fields && Array.isArray(fields.airlines)
    const hasScalarUpdates = updates.length > 0

    if (!hasScalarUpdates && !hasAirlines) return this.findByIdAdmin(id)

    const client = await this.db.connect()
    try {
      await client.query('BEGIN')

      if (hasScalarUpdates) {
        updates.push(`updated_at = now()`)
        values.push(id)
        const { rowCount } = await client.query(
          `UPDATE routines SET ${updates.join(', ')} WHERE id = $${i}`,
          values,
        )
        if ((rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return null
        }
      }

      if (hasAirlines && fields.airlines) {
        const { rowCount } = await client.query(
          `SELECT 1 FROM routines WHERE id = $1`,
          [id],
        )
        if ((rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return null
        }
        await client.query(`DELETE FROM routine_airlines WHERE routine_id = $1`, [id])
        for (const airline of fields.airlines) {
          await client.query(
            `INSERT INTO routine_airlines (routine_id, airline) VALUES ($1, $2)`,
            [id, airline],
          )
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return this.findByIdAdmin(id)
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
    const { rowCount } = await this.db.query(
      `UPDATE routines SET is_active = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3`,
      [active, id, userId],
    )
    if ((rowCount ?? 0) === 0) return null
    return this.findById(id, userId)
  }

  async setActiveAdmin(id: string, active: boolean): Promise<RoutineRow | null> {
    const { rowCount } = await this.db.query(
      `UPDATE routines SET is_active = $1, updated_at = now()
       WHERE id = $2`,
      [active, id],
    )
    if ((rowCount ?? 0) === 0) return null
    return this.findByIdAdmin(id)
  }

  async deactivateByAirline(airlineCode: string): Promise<void> {
    await this.db.query(
      `UPDATE routines SET is_active = false, updated_at = now()
       WHERE id IN (SELECT routine_id FROM routine_airlines WHERE airline = $1)
       AND is_active = true`,
      [airlineCode],
    )
  }

  async deleteByAirline(airlineCode: string): Promise<void> {
    await this.db.query(
      `DELETE FROM routines WHERE id IN (SELECT routine_id FROM routine_airlines WHERE airline = $1)`,
      [airlineCode],
    )
  }

  async deactivateExpired(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE routines SET is_active = false, updated_at = now()
       WHERE is_active = true
         AND outbound_end < CURRENT_DATE
         AND (return_end IS NULL OR return_end < CURRENT_DATE)`,
    )
    return rowCount ?? 0
  }

  async setPendingRequest(routineId: string, airline: string, requestId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO routine_pending_requests (routine_id, airline, request_id, requested_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (routine_id, airline) DO UPDATE SET request_id = $3, requested_at = now()`,
      [routineId, airline, requestId],
    )
  }

  async clearPendingRequest(routineId: string, airline: string): Promise<void> {
    await this.db.query(
      `DELETE FROM routine_pending_requests WHERE routine_id = $1 AND airline = $2`,
      [routineId, airline],
    )
  }

  async getPendingRequest(routineId: string, airline: string): Promise<{ request_id: string; requested_at: Date } | null> {
    const { rows } = await this.db.query<{ request_id: string; requested_at: Date }>(
      `SELECT request_id, requested_at FROM routine_pending_requests WHERE routine_id = $1 AND airline = $2`,
      [routineId, airline],
    )
    return rows[0] ?? null
  }

  async hasPendingRequests(routineId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM routine_pending_requests WHERE routine_id = $1) AS exists`,
      [routineId],
    )
    return rows[0].exists
  }
}
