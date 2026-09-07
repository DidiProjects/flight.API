import { Pool } from 'pg'
import { AirlineRow } from '../../types'
import { AirlineRecommendation, IAirlinesRepository } from './interfaces/IAirlinesRepository'

export class AirlinesRepository implements IAirlinesRepository {
  constructor(private readonly db: Pool) {}

  // `has_roundtrip` is on the list because RoutinesService.create uses it to decide
  // whether to accept a round_trip routine. Outside here the column comes back as
  // undefined, `!airline.has_roundtrip` is true for EVERY airline, and round-trip
  // routine creation gets rejected even for those with the flag on in the bank —
  // Azul included.
  private readonly cols = `code, name, active, has_cash, has_pts, has_hyb, has_roundtrip, batch_size`

  async findAll(): Promise<AirlineRow[]> {
    const { rows } = await this.db.query<AirlineRow>(
      `SELECT ${this.cols} FROM airlines ORDER BY name`,
    )
    return rows
  }

  async findActive(): Promise<AirlineRow[]> {
    const { rows } = await this.db.query<AirlineRow>(
      `SELECT ${this.cols} FROM airlines WHERE active = true ORDER BY name`,
    )
    return rows
  }

  async findRecommendedForRoute(origin: string, destination: string): Promise<AirlineRecommendation[]> {
    const { rows } = await this.db.query<AirlineRecommendation>(`
      WITH ponta AS (
        -- As duas pontas, com o país de cada uma na visão DAQUELA companhia.
        -- lower() dos dois lados: a caixa de country_code da GOL está em
        -- MAIÚSCULA e o resto em minúscula, e sem isso ela some do filtro.
        SELECT a.code,
               lower(o.country_code) AS pais_origem,
               lower(d.country_code) AS pais_destino
        FROM airlines a
        JOIN airports o ON o.airline_code = a.code AND o.airport_code = $1
        JOIN airports d ON d.airline_code = a.code AND d.airport_code = $2
      )
      SELECT ${this.cols.split(', ').map((c) => `a.${c}`).join(', ')},
             (p.code IS NOT NULL AND EXISTS (
                SELECT 1 FROM airline_markets am
                  JOIN market_countries mc ON mc.market_code = am.market_code
                WHERE am.airline_code = a.code
                  AND mc.country_code IN (p.pais_origem, p.pais_destino)
             )) AS recommended,
             CASE
               WHEN p.code IS NULL THEN 'no_route'
               WHEN EXISTS (
                 SELECT 1 FROM airline_markets am
                   JOIN market_countries mc ON mc.market_code = am.market_code
                 WHERE am.airline_code = a.code
                   AND mc.country_code IN (p.pais_origem, p.pais_destino)
               ) THEN 'serves_route'
               ELSE 'outside_market'
             END AS reason
      FROM airlines a
      LEFT JOIN ponta p ON p.code = a.code
      WHERE a.active = true
      -- Recomendadas primeiro; o FRONT não reordena nem reimplementa a regra.
      ORDER BY recommended DESC, a.name
    `, [origin.toUpperCase(), destination.toUpperCase()])
    return rows
  }

  async findByCode(code: string): Promise<AirlineRow | null> {
    const { rows } = await this.db.query<AirlineRow>(
      `SELECT ${this.cols} FROM airlines WHERE code = $1`,
      [code],
    )
    return rows[0] ?? null
  }

  async batchSizesForRoutine(routineId: string): Promise<number[]> {
    const { rows } = await this.db.query<{ batch_size: number }>(
      `SELECT a.batch_size
         FROM routine_airlines ra
         JOIN airlines a ON a.code = ra.airline
        WHERE ra.routine_id = $1`,
      [routineId],
    )
    return rows.map((r) => r.batch_size)
  }

  async create(code: string, name: string): Promise<AirlineRow> {
    const { rows } = await this.db.query<AirlineRow>(
      `INSERT INTO airlines (code, name, active) VALUES ($1, $2, true) RETURNING ${this.cols}`,
      [code, name],
    )
    return rows[0]
  }

  async setActive(code: string, active: boolean): Promise<AirlineRow | null> {
    const { rows } = await this.db.query<AirlineRow>(
      `UPDATE airlines SET active = $1 WHERE code = $2 RETURNING ${this.cols}`,
      [active, code],
    )
    return rows[0] ?? null
  }

  async updateFareTypes(code: string, hasCash: boolean, hasPts: boolean, hasHyb: boolean): Promise<AirlineRow | null> {
    const { rows } = await this.db.query<AirlineRow>(
      `UPDATE airlines SET has_cash = $1, has_pts = $2, has_hyb = $3 WHERE code = $4 RETURNING ${this.cols}`,
      [hasCash, hasPts, hasHyb, code],
    )
    return rows[0] ?? null
  }

  async delete(code: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM airlines WHERE code = $1`,
      [code],
    )
    return (rowCount ?? 0) > 0
  }
}
