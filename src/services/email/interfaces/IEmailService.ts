export interface OfferBlock {
  flightNumber: string
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

export interface AirlineOfferPair {
  airline: string
  currency: string
  outbound: OfferBlock
  return: OfferBlock | null
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
