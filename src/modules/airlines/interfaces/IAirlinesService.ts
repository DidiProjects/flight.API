import { AirlineRow } from '../../../types'
import { AirlineRecommendation } from './IAirlinesRepository'

export interface IAirlinesService {
  listActive(): Promise<AirlineRow[]>
  /** Active airlines for a route, recommended ones first. See the repository. */
  listForRoute(origin: string, destination: string): Promise<AirlineRecommendation[]>
  listAll(): Promise<AirlineRow[]>
  create(code: string, name: string): Promise<AirlineRow>
  activate(code: string): Promise<AirlineRow>
  deactivate(code: string): Promise<AirlineRow>
  updateFareTypes(code: string, hasCash: boolean, hasPts: boolean, hasHyb: boolean): Promise<AirlineRow>
  remove(code: string): Promise<void>
}
