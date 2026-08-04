import { FlightFaresCurrent, IFlightFaresService, Journey } from './interfaces/IFlightFaresService'
import { CurrentBest, IFlightFaresRepository, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

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
    return { ...summary, ...current, journeys: this.toJourneys(current, origin, destination, inbound) }
  }

  /**
   * As jornadas do melhor par, a partir das parcelas que a query já devolve.
   *
   * A moeda é a mesma nas duas: medido no banco, par nenhum mistura moeda — a
   * busca RT é precificada no mercado de quem parte e as duas pernas saem
   * juntas. O campo existe por jornada mesmo assim, para o front nunca ter de
   * herdar moeda de um nível acima (foi assim que ida e volta apareciam
   * rotuladas iguais).
   */
  private toJourneys(
    c: CurrentBest,
    origin: string,
    destination: string,
    inbound?: { from: string; to: string },
  ): Journey[] {
    const outbound: Journey = {
      direction: 'outbound',
      currency:  c.currency,
      cash:      inbound ? (c.best_cash_outbound ?? null)     : c.best_cash,
      pts:       inbound ? (c.best_pts_outbound ?? null)      : c.best_pts,
      hybPts:    inbound ? (c.best_hyb_pts_outbound ?? null)  : c.best_hyb_pts,
      hybCash:   inbound ? (c.best_hyb_cash_outbound ?? null) : c.best_hyb_cash,
      segments:  [{ origin, destination }],
    }
    if (!inbound) return [outbound]

    return [outbound, {
      direction: 'inbound',
      currency:  c.currency,
      cash:      c.best_cash_inbound ?? null,
      pts:       c.best_pts_inbound ?? null,
      hybPts:    c.best_hyb_pts_inbound ?? null,
      hybCash:   c.best_hyb_cash_inbound ?? null,
      // A volta é a ROTA INVERTIDA. `inbound.from/to` são a janela de DATAS da
      // volta, não aeroportos — usá-los aqui punha "2026-09-25" no lugar do
      // IATA, e só apareceu ao chamar a API de verdade.
      segments:  [{ origin: destination, destination: origin }],
    }]
  }

  getByDate(
    airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string,
    inbound?: { from: string; to: string },
  ): Promise<PriceByDate[]> {
    return this.repo.getPriceByDate(airlines, origin, destination, dateFrom, dateTo, inbound)
  }
}
