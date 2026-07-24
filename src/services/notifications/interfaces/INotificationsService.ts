import { RoutineRow } from '../../../types'
import { LatestFaresByDate, PriceHistory } from '../../../modules/flight-fares/interfaces/IFlightFaresRepository'

export interface INotificationsService {
  sendScheduled(): Promise<void>
  /** Dispara um alerta 'target' com uma ou mais ofertas (uma por data do grid que melhorou). */
  dispatchAlert(
    routine: RoutineRow,
    outboundFares: LatestFaresByDate[],
    history: PriceHistory,
    inboundByOutboundDate?: Map<string, LatestFaresByDate>,
  ): Promise<void>
}
