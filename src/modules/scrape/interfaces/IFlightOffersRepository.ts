import { FlightOfferRow } from '../../../types'
import { FlightOfferInput } from '../schema'

export interface IFlightOffersRepository {
  insertMany(
    routineId: string,
    airline: string,
    offers: FlightOfferInput[],
    withinTargetFn: (offer: FlightOfferInput) => boolean,
    scrapedAt: string,
  ): Promise<string[]>
  findByIds(ids: string[]): Promise<FlightOfferRow[]>
}
