import { Pool } from 'pg'
import {
  ITargetAlertStateRepository,
  AlertWatermark,
  PriceBreakdown,
  WatermarkState,
} from './interfaces/ITargetAlertStateRepository'

function toDateStr(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

export class TargetAlertStateRepository implements ITargetAlertStateRepository {
  constructor(private readonly db: Pool) {}

  async getWatermarks(routineId: string, fareType: string): Promise<Map<string, WatermarkState>> {
    const { rows } = await this.db.query<{
      flight_date: string | Date
      notified_amount: string
      notified_breakdown: PriceBreakdown[] | null
    }>(
      `SELECT flight_date, notified_amount, notified_breakdown
       FROM target_alert_state
       WHERE routine_id = $1 AND fare_type = $2`,
      [routineId, fareType],
    )
    const map = new Map<string, WatermarkState>()
    // NUMERIC volta do pg como string — coagir para Number.
    for (const r of rows) {
      map.set(toDateStr(r.flight_date), {
        amount: Number(r.notified_amount),
        breakdown: r.notified_breakdown,
      })
    }
    return map
  }

  async recordNotified(routineId: string, fareType: string, entries: AlertWatermark[]): Promise<Set<string>> {
    if (entries.length === 0) return new Set()

    const dates      = entries.map((e) => e.flightDate)
    const amounts    = entries.map((e) => e.amount)
    const airlines   = entries.map((e) => e.airline)
    const breakdowns = entries.map((e) => JSON.stringify(e.breakdown))

    // ON CONFLICT ... WHERE só atualiza (e só retorna) quando o preço novo é menor;
    // linhas inseridas pela primeira vez também voltam no RETURNING. Assim o e-mail
    // é montado a partir das datas que o banco confirmou como avançadas.
    const { rows } = await this.db.query<{ flight_date: string | Date }>(
      `INSERT INTO target_alert_state (routine_id, flight_date, fare_type, notified_amount, notified_airline, notified_breakdown)
       SELECT $1, d::date, $2, a::numeric, ai, bd::jsonb
       FROM unnest($3::date[], $4::numeric[], $5::text[], $6::text[]) AS t(d, a, ai, bd)
       ON CONFLICT (routine_id, flight_date, fare_type)
       DO UPDATE SET notified_amount    = EXCLUDED.notified_amount,
                     notified_airline   = EXCLUDED.notified_airline,
                     notified_breakdown = EXCLUDED.notified_breakdown,
                     notified_at        = now(),
                     updated_at         = now()
       WHERE EXCLUDED.notified_amount < target_alert_state.notified_amount
       RETURNING flight_date`,
      [routineId, fareType, dates, amounts, airlines, breakdowns],
    )
    return new Set(rows.map((r) => toDateStr(r.flight_date)))
  }

  async cleanupPastDates(): Promise<number> {
    const res = await this.db.query(`DELETE FROM target_alert_state WHERE flight_date < CURRENT_DATE`)
    return res.rowCount ?? 0
  }

  async deleteByRoutine(routineId: string): Promise<number> {
    // Keyed by routine_id, so nothing here is shared with another routine.
    const { rowCount } = await this.db.query(
      `DELETE FROM target_alert_state WHERE routine_id = $1`,
      [routineId],
    )
    return rowCount ?? 0
  }
}
