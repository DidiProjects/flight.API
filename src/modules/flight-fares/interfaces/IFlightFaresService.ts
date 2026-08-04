import { CurrentBest, PriceByDate, PriceHistory } from './IFlightFaresRepository'

/** Um TRAJETO voado: de um aeroporto a outro. Hoje um por jornada. */
export interface Segment {
  origin: string
  destination: string
}

/**
 * O que a companhia VENDE e precifica: a ida, ou a volta.
 *
 * O dinheiro mora aqui — não no trajeto — porque é assim que a tarifa é cotada.
 * `segments` tem um elemento hoje; o dia em que a conexão for modelada, tem N,
 * e nada no contrato precisa mudar.
 */
export interface Journey {
  direction: 'outbound' | 'inbound'
  /** Moeda DESTA jornada, como a companhia cobrou. */
  currency: string | null
  cash: number | null
  pts: number | null
  hybPts: number | null
  hybCash: number | null
  segments: Segment[]
}

export type FlightFaresCurrent = PriceHistory & CurrentBest & {
  /**
   * As jornadas do melhor par: uma em só-ida, duas em ida-e-volta.
   *
   * Substitui os oito campos achatados (`best_cash_outbound`, `best_pts_inbound`
   * …), que não comportavam moeda por jornada sem virar doze. Os antigos seguem
   * no payload enquanto o front não migra.
   *
   * ⚠ Medido em 2026-08-04: as duas jornadas de um par NUNCA têm moedas
   * diferentes (196 linhas, 11 execuções, zero divergência). A busca RT é
   * precificada no mercado de quem parte, e as duas pernas saem juntas. Moeda
   * diferente aparece entre ROTINAS distintas — a mesma perna colhida por uma
   * busca RT e por uma só-ida que parte do outro lado.
   */
  journeys: Journey[]
}

export interface IFlightFaresService {
  getHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory>
  getSummary(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceHistory>
  getCurrent(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<FlightFaresCurrent>
  getByDate(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceByDate[]>
}
