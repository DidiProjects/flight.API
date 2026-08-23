import { z } from 'zod'
import { ExchangeRateHttpClient } from '../ExchangeRateHttpClient'
import { FetchedRate, IExchangeRateProvider } from './IExchangeRateProvider'
import { FxSource } from '../interfaces/IFxRateService'

/**
 * Frankfurter — primary provider.
 *
 * Chosen not for being free, but for being **open source and self-hostable with
 * Docker**: if the public service goes down or changes policy, we bring up our own
 * without changing a line here. ECB reference data.
 *
 * ⚠ Publishes once a day, on business days. Weekends and holidays repeat the last
 * quote — which is why `rateDate` comes from the response and not from `new Date()`.
 */
const responseSchema = z.object({
  // The body carries more fields; `strict` is deliberately not used so the provider
  // can add things without breaking collection.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rates: z.record(z.string(), z.number()),
})

export class FrankfurterProvider implements IExchangeRateProvider {
  readonly source: FxSource = 'frankfurter'

  constructor(
    private readonly http: ExchangeRateHttpClient,
    private readonly baseUrl = 'https://api.frankfurter.dev/v1',
  ) {}

  async fetchToBrl(currency: string): Promise<FetchedRate> {
    const from = encodeURIComponent(currency.toUpperCase())
    const body = await this.http.getJson(`${this.baseUrl}/latest?base=${from}&symbols=BRL`)

    // Validating the body is what separates "the provider changed the format" from
    // "the rate is zero". Without it, a missing field would become NaN and carry on.
    const parsed = responseSchema.safeParse(body)
    if (!parsed.success) {
      throw new Error('frankfurter: resposta fora do formato esperado')
    }

    const rate = parsed.data.rates['BRL']
    if (rate == null) {
      throw new Error(`frankfurter: sem cotação BRL para ${currency}`)
    }

    return { rate, rateDate: parsed.data.date }
  }
}
