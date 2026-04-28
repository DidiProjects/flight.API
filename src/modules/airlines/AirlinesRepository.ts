import { Pool } from 'pg'
import { AirlineRow } from '../../types'
import { IAirlinesRepository } from './interfaces/IAirlinesRepository'

export class AirlinesRepository implements IAirlinesRepository {
  constructor(private readonly db: Pool) {}

  private readonly cols = `code, name, active, has_brl, has_pts, has_hyb`

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

  async findByCode(code: string): Promise<AirlineRow | null> {
    const { rows } = await this.db.query<AirlineRow>(
      `SELECT ${this.cols} FROM airlines WHERE code = $1`,
      [code],
    )
    return rows[0] ?? null
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

  async updateFareTypes(code: string, hasBrl: boolean, hasPts: boolean, hasHyb: boolean): Promise<AirlineRow | null> {
    const { rows } = await this.db.query<AirlineRow>(
      `UPDATE airlines SET has_brl = $1, has_pts = $2, has_hyb = $3 WHERE code = $4 RETURNING ${this.cols}`,
      [hasBrl, hasPts, hasHyb, code],
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
