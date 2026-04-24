import { Pool } from 'pg'
import { BestFareRow } from '../../types'
import { IBestFaresRepository } from './interfaces/IBestFaresRepository'

const FARE_TYPES: Array<{ col: string; type: string }> = [
  { col: 'fare_brl',     type: 'brl' },
  { col: 'fare_pts',     type: 'pts' },
  { col: 'fare_hyb_pts', type: 'hyb' },
]

export class BestFaresRepository implements IBestFaresRepository {
  constructor(private readonly db: Pool) {}

  async upsertFromOffers(routineId: string, offerIds: string[]): Promise<void> {
    if (offerIds.length === 0) return
    const placeholders = offerIds.map((_, i) => `$${i + 3}`).join(',')

    for (const { col, type } of FARE_TYPES) {
      await this.db.query(
        `INSERT INTO best_fares (routine_id, date, is_return, fare_type, amount, flight_offer_id)
         SELECT $1, date, is_return, $2, ${col}, id
         FROM flight_offers
         WHERE id IN (${placeholders}) AND ${col} IS NOT NULL
         ORDER BY ${col} ASC
         ON CONFLICT (routine_id, date, is_return, fare_type) DO UPDATE
           SET amount = EXCLUDED.amount,
               flight_offer_id = EXCLUDED.flight_offer_id,
               updated_at = now()
           WHERE EXCLUDED.amount < best_fares.amount`,
        [routineId, type, ...offerIds],
      )
    }
  }

  async getBest(routineId: string, isReturn: boolean, fareType: string): Promise<BestFareRow | null> {
    const { rows } = await this.db.query<BestFareRow>(
      `SELECT bf.*, row_to_json(fo.*) AS offer
       FROM best_fares bf
       JOIN flight_offers fo ON fo.id = bf.flight_offer_id
       WHERE bf.routine_id = $1 AND bf.is_return = $2 AND bf.fare_type = $3
       ORDER BY bf.amount ASC
       LIMIT 1`,
      [routineId, isReturn, fareType],
    )
    return rows[0] ?? null
  }
}
