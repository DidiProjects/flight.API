/** Where the quote came from. `native` = it was already Real, no conversion. */
export type FxSource = 'frankfurter' | 'currency-api' | 'native'

export interface ConvertedAmount {
  /** The value in BRL. */
  amount: number
  /** How many BRL 1 unit of the source currency is worth. 1 when it was already BRL. */
  rate: number
  source: FxSource
  /** The date OF THE QUOTE, not of today — the ECB publishes on business days. */
  rateDate: string
  /**
   * The rate came from an old cache because every provider failed.
   *
   * It exists so the caller can decide: alerting on an old number may be worse
   * than not alerting. This layer does not decide that on its own.
   */
  stale: boolean
}

/**
 * Currency conversion to Real.
 *
 * Consumed ONLY by another service or controller — no route exposes exchange and
 * no repository talks to the network. The guarantee is by design: the service is
 * injected in `container.ts` and the only class that opens a socket is
 * `ExchangeRateHttpClient`.
 */
export interface IFxRateService {
  /**
   * Converts between any two currencies. `null` when there is no trustworthy rate
   * for either end.
   *
   * The pivot is Real: the two quotes already in cache become a ratio. That way
   * there is no second set of pairs to maintain, and the sanity range keeps being
   * applied on both ends.
   */
  convert(amount: number, from: string, to: string): Promise<ConvertedAmount | null>

  /**
   * Converts to BRL. Returns `null` when there is no trustworthy rate.
   *
   * `null` instead of an exception on purpose: evaluation has to be able to SKIP a
   * pair without taking the whole cycle down. Deciding an alert on a doubtful
   * number is the one outcome that must not happen.
   */
  toBrl(amount: number, currency: string): Promise<ConvertedAmount | null>
}
