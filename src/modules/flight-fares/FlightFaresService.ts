import { FlightFaresCurrent, IFlightFaresService } from './interfaces/IFlightFaresService'
import { IFlightFaresRepository, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

export class FlightFaresService implements IFlightFaresService {
  constructor(private readonly repo: IFlightFaresRepository) {}

  getHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory> {
    return this.repo.getPriceHistory(airline, origin, destination, flightDate)
  }

  getSummary(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string): Promise<PriceHistory> {
    return this.repo.getSummary(airlines, origin, destination, dateFrom, dateTo)
  }

  async getCurrent(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string): Promise<FlightFaresCurrent> {
    const [current, summary] = await Promise.all([
      this.repo.getCurrentBest(airlines, origin, destination, dateFrom, dateTo),
      this.repo.getSummary(airlines, origin, destination, dateFrom, dateTo),
    ])
    return { ...summary, ...current }
  }

  getByDate(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string): Promise<PriceByDate[]> {
    return this.repo.getPriceByDate(airlines, origin, destination, dateFrom, dateTo)
  }
}
