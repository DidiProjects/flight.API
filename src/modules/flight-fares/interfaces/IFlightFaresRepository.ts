export interface FlightFareRow {
  id: string
  scraping_job_id: string
  request_id: string
  flight_number: string | null
  flight_date: string
  is_return: boolean
  origin: string
  destination: string
  airline: string
  departure_time: string | null
  arrival_time: string | null
  duration_min: number | null
  stops: number | null
  currency: string | null
  fare_cash: number | null
  fare_pts: number | null
  fare_hyb_pts: number | null
  fare_hyb_cash: number | null
  /** Par de origem da tarifa. NULL = colhida numa busca one-way avulsa. */
  return_date: string | null
  /**
   * Voo de IDA em cujo contexto esta volta foi precificada. NULL na ida e em
   * qualquer tarifa one-way. É o vínculo 1-para-N.
   */
  paired_outbound_flight: string | null
  /**
   * Só na ida: as voltas dela existem mas uma limitação conhecida impede vê-las
   * (login do TudoAzul em pontos). Par exibido sem total, sem alerta.
   */
  inbound_unavailable: boolean
  scraped_at: Date
}

export interface LatestFaresByDate {
  airline: string
  flight_date: string
  is_return: boolean
  departure_time: string | null
  arrival_time: string | null
  duration_min: number | null
  stops: number | null
  currency: string | null
  fare_cash: number | null
  fare_pts: number | null
  fare_hyb_pts: number | null
  fare_hyb_cash: number | null
  scraped_at: Date
}

export interface PriceHistory {
  currency: string | null
  avg_cash_30d: number | null
  min_cash_30d: number | null
  p20_cash_30d: number | null
  avg_pts_30d: number | null
  min_pts_30d: number | null
}

export interface CurrentBest {
  currency: string | null
  best_cash: number | null
  best_pts: number | null
  best_hyb_pts: number | null
  best_hyb_cash: number | null
  scraped_at: Date | null
  /**
   * Round-trip sem total porque a volta é indefinida (limitação conhecida da
   * companhia). Distingue "a viagem não tem total" de "nada foi coletado" — a
   * ida existe, ela só não é o preço da viagem.
   */
  inbound_unavailable?: boolean
  /**
   * Parcelas do melhor par, para exibir o total segregado em ida e volta.
   *
   * Cada dimensão traz as parcelas da SUA combinação vencedora — o par mais
   * barato em dinheiro não é necessariamente o mais barato em pontos.
   *
   * Ficam nulas quando o total veio do bundle da companhia (preço único, sem
   * divisão publicada) e em rotina one-way, que não tem par.
   */
  best_cash_outbound?: number | null
  best_cash_inbound?: number | null
  best_pts_outbound?: number | null
  best_pts_inbound?: number | null
  best_hyb_pts_outbound?: number | null
  best_hyb_pts_inbound?: number | null
  best_hyb_cash_outbound?: number | null
  best_hyb_cash_inbound?: number | null
}

export interface PriceByDate {
  flight_date: string
  best_cash: number | null
  best_pts: number | null
  best_hyb_pts: number | null
  best_hyb_cash: number | null
}

export interface IFlightFaresRepository {
  insertMany(jobId: string, requestId: string, fares: Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'request_id' | 'scraped_at'>[]): Promise<number>
  getLatestByRoute(airline: string, origin: string, destination: string, dateFrom: string, dateTo: string, returnDate: string | null, maxAgeHours?: number): Promise<LatestFaresByDate[]>
  getLatestPairs(airline: string, origin: string, destination: string, outFrom: string, outTo: string, inFrom: string, inTo: string, maxAgeHours?: number): Promise<PairFareRow[]>
  getPriceHistory(airline: string, origin: string, destination: string, flightDate: string): Promise<PriceHistory>
  /** Com `inbound`, a régua é a distribuição dos TOTAIS de par; sem, a de tarifa avulsa. */
  getSummary(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceHistory>
  getCurrentBest(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<CurrentBest>
  /** Com `inbound`, cada data de IDA traz o menor total de par daquele dia. */
  getPriceByDate(airlines: string[], origin: string, destination: string, dateFrom: string, dateTo: string, inbound?: { from: string; to: string }): Promise<PriceByDate[]>
  /** Moeda já observada em tarifas coletadas para o trajeto/companhias (fonte primária da rotina). */
  getKnownCurrency(airlines: string[], origin: string, destination: string): Promise<string | null>
  aggregateToDailyBucket(bucketDate: string): Promise<number>
  cleanupOlderThan(days: number): Promise<number>
}

/** Linha de tarifa colhida numa busca de PAR (ida-e-volta). */
export interface PairFareRow extends LatestFaresByDate {
  return_date: string
  origin: string
  destination: string
  /** Execução que colheu o par. É a identidade do par: as duas pernas a compartilham. */
  request_id: string
  /**
   * Data de IDA do par. Vem da perna de ida — a de volta tem `flight_date`
   * igual à data dela, então `flight_date` não serve para agrupar o par.
   */
  pair_outbound_date: string
  flight_number: string | null
  /** Ida que precificou esta volta. NULL na ida (e em volta de coleta antiga). */
  paired_outbound_flight: string | null
  /** Só na ida: volta indefinida por limitação conhecida (não é par corrompido). */
  inbound_unavailable: boolean
  bundle_cash: string | number | null
  bundle_pts: string | number | null
  bundle_hyb_pts: string | number | null
  bundle_hyb_cash: string | number | null
}
