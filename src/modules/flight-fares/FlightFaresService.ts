import { FlightFaresCurrent, IFlightFaresService, Journey } from './interfaces/IFlightFaresService'
import { CurrentBest, IFlightFaresRepository, PriceByDate, PriceHistory } from './interfaces/IFlightFaresRepository'

/**
 * Leitura de tarifas SEM rede.
 *
 * O câmbio saiu daqui em 017: converter na leitura batia na API a cada abertura
 * de histórico e fazia a régua de 30 dias se mexer com a cotação do dia. A
 * conversão passou para a ingestão da análise, com a taxa gravada na linha.
 */
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
    // O total do par já vem somado em Real pelo SQL (017): a conversão acontece
    // uma vez, na ingestão da análise, com a taxa gravada na linha. Antes era
    // aqui, a cada abertura de tela, e o valor mudava com a cotação do dia.
    //
    // A coerção continua sendo necessária: NUMERIC volta do pg como STRING, e
    // quem a fazia era o `pairTotal` que somava. Sem ela o total sai do JSON
    // como "12548.00" e qualquer comparação no front vira lexicográfica.
    return {
      ...summary,
      ...current,
      best_cash:     this.num(current.best_cash),
      best_pts:      this.num(current.best_pts),
      best_hyb_pts:  this.num(current.best_hyb_pts),
      best_hyb_cash: this.num(current.best_hyb_cash),
      journeys: this.toJourneys(current, origin, destination, inbound),
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
