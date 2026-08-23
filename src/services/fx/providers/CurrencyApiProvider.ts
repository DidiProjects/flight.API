import { z } from 'zod'
import { ExchangeRateHttpClient } from '../ExchangeRateHttpClient'
import { FetchedRate, IExchangeRateProvider } from './IExchangeRateProvider'
import { FxSource } from '../interfaces/IFxRateService'

/**
 * @fawazahmed0/currency-api — backup provider.
 *
 * Steps in only when Frankfurter does not answer. It sits second because it depends
 * on a third-party CDN and we cannot host a copy of our own — the exact opposite of
 * the argument that put Frankfurter first.
 *
 * Format: `{ "date": "2026-08-04", "gbp": { "brl": 6.82, ... } }` — currencies in
 * lowercase, and the object key is the source currency.
 */
const responseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).catchall(z.unknown())

export class CurrencyApiProvider implements IExchangeRateProvider {
  readonly source: FxSource = 'currency-api'

  constructor(
    private readonly http: ExchangeRateHttpClient,
    private readonly baseUrl = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies',
  ) {}

  async fetchToBrl(currency: string): Promise<FetchedRate> {
    const code = currency.toLowerCase()
    // Letters only: the currency comes from the bank, but building a URL path with an
    // unsanitised value is how a host allowlist gets crossed by path traversal.
    if (!/^[a-z]{3}$/.test(code)) {
      throw new Error(`currency-api: código de moeda inválido: ${currency}`)
    }

    const body = await this.http.getJson(`${this.baseUrl}/${code}.json`)

    const parsed = responseSchema.safeParse(body)
    if (!parsed.success) {
      throw new Error('currency-api: resposta fora do formato esperado')
    }

    const table = parsed.data[code]
    const rate = isRecord(table) ? table['brl'] : undefined
    if (typeof rate !== 'number') {
      throw new Error(`currency-api: sem cotação BRL para ${currency}`)
    }

    return { rate, rateDate: parsed.data.date }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
