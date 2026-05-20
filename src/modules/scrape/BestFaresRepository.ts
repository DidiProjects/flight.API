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
    const placeholders = offerIds.map((_, i) => `$${i + 4}`).join(',')

    for (const { col, type } of FARE_TYPES) {
      await this.db.query(
        `INSERT INTO best_fares (routine_id, airline, date, is_return, fare_type, amount, flight_offer_id, currency, updated_at, analysis_id)
         SELECT DISTINCT ON (fo.airline, fo.date, fo.is_return) $1, fo.airline, fo.date, fo.is_return, $2, ${col}, fo.id, $3, now(), $4
         FROM flight_offers fo
         WHERE fo.id IN (${placeholders}) AND fo.${col} IS NOT NULL
         ORDER BY fo.airline, fo.date, fo.is_return, fo.${col} ASC
         ON CONFLICT (routine_id, airline, date, is_return, fare_type) DO UPDATE
           SET amount          = EXCLUDED.amount,
               flight_offer_id = EXCLUDED.flight_offer_id,
               currency        = EXCLUDED.currency,
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
       ORDER BY bf.amount ASC, bf.updated_at DESC
       LIMIT 1`,
      [routineId, isReturn, fareType],
    )
    return rows[0] ?? null
  }

  async getBestPerAirline(routineId: string, isReturn: boolean, fareType: string): Promise<BestFareRow[]> {
    const { rows } = await this.db.query<BestFareRow>(
      `SELECT DISTINCT ON (bf.airline) bf.*, row_to_json(fo.*) AS offer
       FROM best_fares bf
       JOIN flight_offers fo ON fo.id = bf.flight_offer_id
       WHERE bf.routine_id = $1 AND bf.is_return = $2 AND bf.fare_type = $3
         AND bf.date >= CURRENT_DATE
         AND bf.updated_at >= now() - interval '4 hours'
       ORDER BY bf.airline, bf.amount ASC, bf.updated_at DESC`,
      [routineId, isReturn, fareType],
    )
    return rows
  }
}
