export interface OfferBlock {
  flightNumber: string
  date: string
  origin: string
  departureTime: string
  destination: string
  arrivalTime: string
  durationMin: number
  stops: number
  fareBrl?: number | null
  farePts?: number | null
  fareHybPts?: number | null
  fareHybBrl?: number | null
}

export interface FlightAlertEmailParams {
  primaryEmail: string
  primaryUnsubLink: string
  ccRecipients: Array<{ email: string; unsubLink: string }>
  subject: string
  routineName: string
  origin: string
  destination: string
  outboundOffer?: OfferBlock | null
  returnOffer?: OfferBlock | null
  passengers: number
  fareType: string
  airline: string
}

export interface IEmailService {
  sendFlightAlert(params: FlightAlertEmailParams): Promise<void>
  sendProvisionalPassword(email: string, password: string): Promise<void>
  sendPasswordReset(email: string, token: string): Promise<void>
  sendUserApproved(email: string): Promise<void>
}
