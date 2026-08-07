import { z } from 'zod'
import { ExchangeRateHttpClient } from '../ExchangeRateHttpClient'
import { FetchedRate, IExchangeRateProvider } from './IExchangeRateProvider'
import { FxSource } from '../interfaces/IFxRateService'

/**
 * @fawazahmed0/currency-api — provedor de reserva.
 *
 * Entra só quando a Frankfurter não responde. Fica em segundo lugar porque
 * depende de CDN de terceiro e não temos como subir uma cópia nossa — o
 * contrário exato do argumento que colocou a Frankfurter em primeiro.
 *
 * Formato: `{ "date": "2026-08-04", "gbp": { "brl": 6.82, ... } }` — moedas em
 * minúsculo, e a chave do objeto é a moeda de origem.
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
    // Só letras: a moeda vem do banco, mas montar caminho de URL com valor não
    // sanitizado é como se atravessa uma allowlist de host por path traversal.
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
