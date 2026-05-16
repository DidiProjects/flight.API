import { Pool } from 'pg'
import { BestFareRow } from '../../types'
import { IBestFaresRepository } from './interfaces/IBestFaresRepository'

const FARE_TYPES: Array<{ col: string; type: string }> = [
  { col: 'fare_cash',    type: 'cash' },
  { col: 'fare_pts',     type: 'pts' },
  { col: 'fare_hyb_pts', type: 'hyb' },
]

export class BestFaresRepository implements IBestFaresRepository {
  constructor(private readonly db: Pool) {}

  async upsertFromOffers(routineId: string, offerIds: string[], currency: string, analysisId: string): Promise<void> {
    if (offerIds.length === 0) return
    const placeholders = offerIds.map((_, i) => `$${i + 5}`).join(',')

    for (const { col, type } of FARE_TYPES) {
      await this.db.query(
        `INSERT INTO best_fares (routine_id, date, is_return, fare_type, amount, flight_offer_id, currency, updated_at, analysis_id)
         SELECT DISTINCT ON (date, is_return) $1, date, is_return, $2, ${col}, id, $3, now(), $4
         FROM flight_offers
         WHERE id IN (${placeholders}) AND ${col} IS NOT NULL
         ORDER BY date, is_return, ${col} ASC
         ON CONFLICT (routine_id, date, is_return, fare_type) DO UPDATE
           SET amount          = CASE WHEN EXCLUDED.amount < best_fares.amount THEN EXCLUDED.amount          ELSE best_fares.amount          END,
               flight_offer_id = CASE WHEN EXCLUDED.amount < best_fares.amount THEN EXCLUDED.flight_offer_id ELSE best_fares.flight_offer_id END,
               currency        = CASE WHEN EXCLUDED.amount < best_fares.amount THEN EXCLUDED.currency        ELSE best_fares.currency        END,
               updated_at      = now(),
               analysis_id     = EXCLUDED.analysis_id`,
        [routineId, type, currency, analysisId, ...offerIds],
      )
    }
  }

  async getBest(routineId: string, isReturn: boolean, fareType: string): Promise<BestFareRow | null> {
    const { rows } = await this.db.query<BestFareRow>(
      `SELECT bf.*, row_to_json(fo.*) AS offer
       FROM best_fares bf
       JOIN flight_offers fo ON fo.id = bf.flight_offer_id
       WHERE bf.routine_id = $1 AND bf.is_return = $2 AND bf.fare_type = $3
         AND bf.date >= CURRENT_DATE
         AND bf.updated_at >= now() - interval '4 hours'
       ORDER BY bf.updated_at DESC, bf.amount ASC
       LIMIT 1`,
      [routineId, isReturn, fareType],
    )
    return rows[0] ?? null
  }
}
