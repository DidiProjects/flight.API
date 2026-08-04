import { FxSource } from '../interfaces/IFxRateService'

export interface FetchedRate {
  /** Quantos BRL vale 1 unidade de `currency`. */
  rate: number
  /** A data que o provedor declara para esta cotação (YYYY-MM-DD). */
  rateDate: string
}

/**
 * Um provedor de cotação. Sabe falar com UMA fonte e traduzir a resposta dela.
 *
 * Não sabe de cache, de fallback nem de disjuntor — isso é política e vive no
 * `FxRateService`. Assim trocar de fonte não mexe na política, e mudar a
 * política não mexe em nenhuma fonte.
 */
export interface IExchangeRateProvider {
  readonly source: FxSource

  /**
   * Cotação de `currency` para BRL. Lança quando não consegue — quem chama
   * trata, decide o fallback e conta a falha para o disjuntor.
   */
  fetchToBrl(currency: string): Promise<FetchedRate>
}
