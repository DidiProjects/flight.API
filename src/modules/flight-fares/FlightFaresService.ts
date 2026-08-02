import { FlightFaresCurrent, IFlightFaresService } from './interfaces/IFlightFaresService'
import { IFlightFaresRepository, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

export class FlightFaresService implements IFlightFaresService {
  constructor(private readonly repo: IFlightFaresRepository) {}

  getHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory> {
    return this.repo.getPriceHistory(airline, origin, destination, flightDate)
  }

  getSummary(
    airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string,
    // Rotina round_trip: a régua é a distribuição dos totais de PAR, senão o
    // veredito compara duas pernas contra a média de uma.
    inbound?: { from: string; to: string },
  ): Promise<PriceHistory> {
    return this.repo.getSummary(airlines, origin, destination, dateFrom, dateTo, inbound)
  }

  async getCurrent(
    airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string,
    // Rotina round_trip: o preço atual é o TOTAL do par, não o da perna de ida.
    inbound?: { from: string; to: string },
  ): Promise<FlightFaresCurrent> {
    // A régua acompanha o valor: com `inbound`, os dois são de par.
    const [current, summary] = await Promise.all([
      this.repo.getCurrentBest(airlines, origin, destination, dateFrom, dateTo, inbound),
      this.repo.getSummary(airlines, origin, destination, dateFrom, dateTo, inbound),
    ])
    return { ...summary, ...current }
  }

  getByDate(
    airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string,
    inbound?: { from: string; to: string },
  ): Promise<PriceByDate[]> {
    return this.repo.getPriceByDate(airlines, origin, destination, dateFrom, dateTo, inbound)
  }
}
