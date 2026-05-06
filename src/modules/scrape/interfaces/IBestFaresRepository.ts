import { BestFareRow } from '../../../types'

export interface IBestFaresRepository {
  upsertFromOffers(routineId: string, offerIds: string[], currency: string): Promise<void>
  getBest(routineId: string, isReturn: boolean, fareType: string): Promise<BestFareRow | null>
}
