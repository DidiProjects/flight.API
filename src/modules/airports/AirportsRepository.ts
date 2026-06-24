import { Pool } from 'pg'
import { AirportInput, AirportRow, IAirportsRepository, UpsertResult } from './interfaces/IAirportsRepository'

export class AirportsRepository implements IAirportsRepository {
  constructor(private readonly db: Pool) {}

  async upsertBatch(airlineCode: string, airports: AirportInput[]): Promise<UpsertResult> {
    if (airports.length === 0) return { inserted: 0, updated: 0, unchanged: 0 }

    const values: unknown[] = []
    const placeholders: string[] = []

    airports.forEach((a, i) => {
      const base = i * 9
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
      )
      values.push(
        airlineCode,
        a.code.toUpperCase(),
        a.name,
        a.timezone,
        a.countryCode,
        a.countryName,
        a.city,
        a.region,
        a.currency,
      )
    })

    const sql = `
      INSERT INTO airports (airline_code, airport_code, name, timezone, country_code, country_name, city, region, currency)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (airline_code, airport_code) DO UPDATE SET
        name         = EXCLUDED.name,
        timezone     = EXCLUDED.timezone,
        country_code = EXCLUDED.country_code,
        country_name = EXCLUDED.country_name,
        city         = EXCLUDED.city,
        region       = EXCLUDED.region,
        currency     = EXCLUDED.currency,
        updated_at   = NOW()
      WHERE
        airports.name         IS DISTINCT FROM EXCLUDED.name         OR
        airports.timezone     IS DISTINCT FROM EXCLUDED.timezone     OR
        airports.country_code IS DISTINCT FROM EXCLUDED.country_code OR
        airports.country_name IS DISTINCT FROM EXCLUDED.country_name OR
        airports.city         IS DISTINCT FROM EXCLUDED.city         OR
        airports.region       IS DISTINCT FROM EXCLUDED.region       OR
        airports.currency     IS DISTINCT FROM EXCLUDED.currency
      RETURNING (xmax = 0) AS is_inserted, (xmax != 0) AS is_updated
    `

    const { rows } = await this.db.query<{ is_inserted: boolean; is_updated: boolean }>(sql, values)

    let inserted = 0
    let updated = 0
    for (const row of rows) {
      if (row.is_inserted) inserted++
      else if (row.is_updated) updated++
    }
    // Rows not returned by RETURNING means they were unchanged (DO UPDATE WHERE clause was false)
    const unchanged = airports.length - rows.length

    return { inserted, updated, unchanged }
  }

  async hasAirport(airlineCode: string, airportCode: string): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM airports WHERE airline_code = $1 AND airport_code = $2
       ) AS exists`,
      [airlineCode, airportCode.toUpperCase()],
    )
    return rows[0].exists
  }

  async getCurrency(airlineCode: string, airportCode: string): Promise<string | null> {
    const { rows } = await this.db.query<{ currency: string | null }>(
      `SELECT currency FROM airports WHERE airline_code = $1 AND airport_code = $2`,
      [airlineCode, airportCode.toUpperCase()],
    )
    return rows[0]?.currency ?? null
  }

  async listByAirline(airlineCode: string): Promise<AirportRow[]> {
    const { rows } = await this.db.query<AirportRow>(
      `SELECT id, airline_code, airport_code, name, timezone, country_code, country_name, city, region, currency, updated_at
       FROM airports
       WHERE airline_code = $1
       ORDER BY airport_code`,
      [airlineCode],
    )
    return rows
  }
}
