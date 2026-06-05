import { AirportInput, AirportRow, UpsertResult } from './IAirportsRepository'

export interface IAirportsService {
  upsertCoverage(airlineCode: string, airports: AirportInput[]): Promise<UpsertResult>
  listByAirline(airlineCode: string): Promise<AirportRow[]>
}
