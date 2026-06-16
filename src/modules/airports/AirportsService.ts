import { IAirportsService } from './interfaces/IAirportsService'
import { IAirportsRepository, AirportInput, AirportRow, UpsertResult } from './interfaces/IAirportsRepository'
import { IAirlinesRepository } from '../airlines/interfaces/IAirlinesRepository'
import { NotFoundError } from '../../utils/errors'

export class AirportsService implements IAirportsService {
  constructor(
    private readonly airportsRepo: IAirportsRepository,
    private readonly airlinesRepo: IAirlinesRepository,
  ) {}

  async upsertCoverage(airlineCode: string, airports: AirportInput[]): Promise<UpsertResult> {
    const airline = await this.airlinesRepo.findByCode(airlineCode)
    if (!airline) throw new NotFoundError(`Companhia aérea '${airlineCode}' não encontrada`)
    return this.airportsRepo.upsertBatch(airlineCode, this.mergeByCode(airports))
  }

  private mergeByCode(airports: AirportInput[]): AirportInput[] {
    const merged = new Map<string, AirportInput>()
    for (const airport of airports) {
      const key = airport.code.toUpperCase()
      const existing = merged.get(key)
      merged.set(key, existing ? this.mergeAirports(existing, airport) : airport)
    }
    return Array.from(merged.values())
  }

  private mergeAirports(a: AirportInput, b: AirportInput): AirportInput {
    return {
      code:        a.code,
      name:        a.name        ?? b.name,
      timezone:    a.timezone    ?? b.timezone,
      countryCode: a.countryCode ?? b.countryCode,
      countryName: a.countryName ?? b.countryName,
      city:        a.city        ?? b.city,
      region:      a.region      ?? b.region,
      currency:    a.currency    ?? b.currency,
    }
  }

  async listByAirline(airlineCode: string): Promise<AirportRow[]> {
    return this.airportsRepo.listByAirline(airlineCode)
  }
}
