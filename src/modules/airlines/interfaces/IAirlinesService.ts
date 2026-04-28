import { AirlineRow } from '../../../types'

export interface IAirlinesService {
  listActive(): Promise<AirlineRow[]>
  listAll(): Promise<AirlineRow[]>
  create(code: string, name: string): Promise<AirlineRow>
  activate(code: string): Promise<AirlineRow>
  deactivate(code: string): Promise<AirlineRow>
  updateFareTypes(code: string, hasBrl: boolean, hasPts: boolean, hasHyb: boolean): Promise<AirlineRow>
  remove(code: string): Promise<void>
}
