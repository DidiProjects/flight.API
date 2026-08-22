export interface OfferBlock {
  flightNumber: string
  /** Currency of THIS leg, as the airline charged it. Never inherited from the pair. */
  currency: string
  date: string
  origin: string
  departureTime: string
  destination: string
  arrivalTime: string
  durationMin: number
  stops: number
  fareCash?: number | null
  farePts?: number | null
  fareHybPts?: number | null
  fareHybCash?: number | null
}

/**
 * The pair total, already in the target unit (Real on a `cash` routine).
 *
 * It comes ready from evaluation: it is the number that actually fired the alert.
 * The e-mail does not add leg to leg — summing £ with € gives a meaningless number.
 */
export interface AlertTotal {
  amount: number
  currency: string
  /** Was any leg converted? Then the e-mail states the rate used. */
  converted: boolean
  rateDate: string | null
}

export interface AirlineOfferPair {
  airline: string
  outbound: OfferBlock
  return: OfferBlock | null
  /** Round-trip only. `null` on a one-way routine, which has no pair total. */
  total: AlertTotal | null
}

export interface FlightAlertEmailParams {
  primaryEmail: string
  primaryUnsubLink: string
  ccRecipients: Array<{ email: string; unsubLink: string }>
  subject: string
  routineName: string
  origin: string
  destination: string
  airlineOffers: AirlineOfferPair[]
  passengers: number
  fareType: string
  historyNote?: string
}

export interface DailyBestRoutineSection {
  routineName: string
  origin: string
  destination: string
  passengers: number
  fareType: string
  airlineOffers: AirlineOfferPair[]
  unsubLink: string
}

export interface DailyBestEmailParams {
  primaryEmail: string
  routines: DailyBestRoutineSection[]
}

export interface IEmailService {
  sendFlightAlert(params: FlightAlertEmailParams): Promise<void>
  sendDailyBest(params: DailyBestEmailParams): Promise<void>
  sendProvisionalPassword(email: string, password: string): Promise<void>
  sendPasswordReset(email: string, token: string): Promise<void>
  sendUserApproved(email: string): Promise<void>
}
