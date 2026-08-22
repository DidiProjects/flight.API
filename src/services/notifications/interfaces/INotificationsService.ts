import { RoutineRow } from '../../../types'
import { LatestFaresByDate, PriceHistory } from '../../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { AlertTotal } from '../../email/interfaces/IEmailService'

export interface INotificationsService {
  sendScheduled(): Promise<void>
  /**
   * Resends the daily summary of ONE routine with current data, skipping the 12h
   * de-dup. `false` when there is no fare to build the e-mail from.
   */
  resendDailySummary(routine: RoutineRow): Promise<boolean>
  /** Fires a 'target' alert with one or more offers (one per grid date that improved). */
  dispatchAlert(
    routine: RoutineRow,
    outboundFares: LatestFaresByDate[],
    history: PriceHistory,
    inboundByOutboundDate?: Map<string, LatestFaresByDate>,
    /**
     * Pair total per outbound date, already in the target unit. It comes from
     * evaluation — it is the number that fired the alert, and the only one that can
     * be summed when the legs are in different currencies.
     */
    totalsByDate?: Map<string, AlertTotal>,
  ): Promise<void>
}
