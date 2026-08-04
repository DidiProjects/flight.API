import { RoutineRow } from '../../../types'
import { LatestFaresByDate, PriceHistory } from '../../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { AlertTotal } from '../../email/interfaces/IEmailService'

export interface INotificationsService {
  sendScheduled(): Promise<void>
  /** Dispara um alerta 'target' com uma ou mais ofertas (uma por data do grid que melhorou). */
  dispatchAlert(
    routine: RoutineRow,
    outboundFares: LatestFaresByDate[],
    history: PriceHistory,
    inboundByOutboundDate?: Map<string, LatestFaresByDate>,
    /**
     * Total do par por data de ida, já na unidade do alvo. Vem da avaliação —
     * é o número que disparou o alerta, e o único que pode ser somado quando as
     * pernas estão em moedas diferentes.
     */
    totalsByDate?: Map<string, AlertTotal>,
  ): Promise<void>
}
