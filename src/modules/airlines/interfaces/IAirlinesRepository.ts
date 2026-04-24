import { AirlineRow } from '../../../types'

export interface IAirlinesRepository {
  findActive(): Promise<AirlineRow[]>
}
