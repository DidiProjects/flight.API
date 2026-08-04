import { FlightFaresCurrent, IFlightFaresService, Journey } from './interfaces/IFlightFaresService'
import { CurrentBest, IFlightFaresRepository, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'
import { IFxRateService } from '../../services/fx/interfaces/IFxRateService'

export class FlightFaresService implements IFlightFaresService {
  constructor(
    private readonly repo: IFlightFaresRepository,
    private readonly fx: IFxRateService,
  ) {}

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
    const journeys = this.toJourneys(current, origin, destination, inbound)
    const total = await this.pairTotal(journeys)

    // O total sobrescreve o que veio do SQL: lá ele só existe quando as duas
    // pernas já estão na mesma moeda. Aqui ele existe sempre, na moeda da IDA.
    return {
      ...summary,
      ...current,
      ...(total ? { best_cash: total.amount, currency: total.currency } : {}),
      journeys,
    }
  }

  /**
   * Total do par, SEMPRE na moeda da tarifa de ida.
   *
   * A volta é convertida para a moeda de quem parte. Assim o total tem uma
   * moeda previsível — a mesma da ida — em vez de existir só quando as duas
   * pernas coincidem e sumir quando não.
   *
   * `null` quando não é par, quando falta a parcela de alguma perna (bundle da
   * companhia é preço único, sem divisão publicada) ou quando não há cotação
   * confiável. Nesses casos o card mostra as parcelas e omite o total — nunca
   * um número inventado.
   */
  private async pairTotal(journeys: Journey[]): Promise<{ amount: number; currency: string } | null> {
    if (journeys.length < 2) return null
    const [out, inb] = journeys
    if (!out?.currency || !inb?.currency) return null
    if (out.cash == null || inb.cash == null) return null

    const convertida = await this.fx.convert(inb.cash, inb.currency, out.currency)
    if (convertida == null) return null

    return {
      amount: Math.round((out.cash + convertida.amount) * 100) / 100,
      currency: out.currency,
    }
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
  /**
   * NUMERIC volta do pg como STRING.
   *
   * Sem coagir, `out.cash + in.cash` vira concatenação ("4921.00" + "7627.00" =
   * "4921.007627.00"), o Math.round disso é NaN e o JSON serializa NaN como
   * null — o total simplesmente sumia do card. O projeto já tropeçou nisso na
   * comparação de preços (que virava lexicográfica); aqui o sintoma era outro.
   */
  private num(v: unknown): number | null {
    if (v == null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  private toJourneys(
    c: CurrentBest,
    origin: string,
    destination: string,
    inbound?: { from: string; to: string },
  ): Journey[] {
    const outbound: Journey = {
      direction: 'outbound',
      currency:  c.currency,
      cash:      this.num(inbound ? c.best_cash_outbound     : c.best_cash),
      pts:       this.num(inbound ? c.best_pts_outbound      : c.best_pts),
      hybPts:    this.num(inbound ? c.best_hyb_pts_outbound  : c.best_hyb_pts),
      hybCash:   this.num(inbound ? c.best_hyb_cash_outbound : c.best_hyb_cash),
      segments:  [{ origin, destination }],
    }
    if (!inbound) return [outbound]

    return [outbound, {
      direction: 'inbound',
      currency:  c.currency,
      cash:      this.num(c.best_cash_inbound),
      pts:       this.num(c.best_pts_inbound),
      hybPts:    this.num(c.best_hyb_pts_inbound),
      hybCash:   this.num(c.best_hyb_cash_inbound),
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
