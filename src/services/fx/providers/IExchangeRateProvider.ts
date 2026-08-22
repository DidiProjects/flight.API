import { FxSource } from '../interfaces/IFxRateService'

export interface FetchedRate {
  /** How many BRL 1 unit of `currency` is worth. */
  rate: number
  /** The date the provider declares for this quote (YYYY-MM-DD). */
  rateDate: string
}

/**
 * A quote provider. Knows how to talk to ONE source and translate its response.
 *
 * It knows nothing of cache, fallback or circuit breaker — that is policy and lives
 * in `FxRateService`. So swapping the source does not touch the policy, and changing
 * the policy does not touch any source.
 */
export interface IExchangeRateProvider {
  readonly source: FxSource

  /**
   * Quote of `currency` against BRL. Throws when it cannot — the caller handles it,
   * decides the fallback and counts the failure towards the breaker.
   */
  fetchToBrl(currency: string): Promise<FetchedRate>
}
