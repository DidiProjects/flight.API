import { CurrentBest, PriceByDate, PriceHistory } from './IFlightFaresRepository'

export type FlightFaresCurrent = PriceHistory & CurrentBest

export interface IFlightFaresService {
  getHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory>
  getSummary(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string): Promise<PriceHistory>
  getCurrent(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<FlightFaresCurrent>
  getByDate(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string): Promise<PriceByDate[]>
}
