export interface AirportRow {
  id: string
  airline_code: string
  airport_code: string
  name: string | null
  timezone: string | null
  country_code: string | null
  country_name: string | null
  city: string | null
  region: string | null
  currency: string | null
  updated_at: Date
}

export interface UpsertResult {
  inserted: number
  updated: number
  unchanged: number
}

export interface AirportInput {
  code: string
  name?: string
  timezone?: string
  countryCode?: string
  countryName?: string
  city?: string
  region?: string
  currency?: string
}

export interface IAirportsRepository {
  upsertBatch(airlineCode: string, airports: AirportInput[]): Promise<UpsertResult>
  listByAirline(airlineCode: string): Promise<AirportRow[]>
  getCurrency(airlineCode: string, airportCode: string): Promise<string | null>
  getCountryCode(airportCode: string): Promise<string | null>
  hasAirport(airlineCode: string, airportCode: string): Promise<boolean>
}
