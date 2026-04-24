import { Pool } from 'pg'
import { AirlineRow } from '../../types'
import { IAirlinesRepository } from './interfaces/IAirlinesRepository'

export class AirlinesRepository implements IAirlinesRepository {
  constructor(private readonly db: Pool) {}

  async findActive(): Promise<AirlineRow[]> {
    const { rows } = await this.db.query<AirlineRow>(
      `SELECT code, name, active FROM airlines WHERE active = true ORDER BY name`,
    )
    return rows
  }
}
