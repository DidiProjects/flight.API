import { AirlineRow } from '../../../types'

export interface IAirlinesRepository {
  findAll(): Promise<AirlineRow[]>
  findActive(): Promise<AirlineRow[]>
  findByCode(code: string): Promise<AirlineRow | null>
  create(code: string, name: string): Promise<AirlineRow>
  setActive(code: string, active: boolean): Promise<AirlineRow | null>
  updateFareTypes(code: string, hasBrl: boolean, hasPts: boolean, hasHyb: boolean): Promise<AirlineRow | null>
  delete(code: string): Promise<boolean>
}
