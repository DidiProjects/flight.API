export interface OfferBlock {
  flightNumber: string
  /** Moeda DESTA perna, como a companhia cobrou. Nunca herdada do par. */
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
 * O total do par, já na unidade do alvo (Real em rotina `cash`).
 *
 * Vem pronto da avaliação: é o número que de fato disparou o alerta. O e-mail
 * não soma perna com perna — somar £ com € daria número sem significado.
 */
export interface AlertTotal {
  amount: number
  currency: string
  /** Alguma perna foi convertida? Então o e-mail diz a cotação usada. */
  converted: boolean
  rateDate: string | null
}

export interface AirlineOfferPair {
  airline: string
  outbound: OfferBlock
  return: OfferBlock | null
  /** Só em ida-e-volta. `null` em rotina só-ida, que não tem total de par. */
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
