import { z } from 'zod'
import { ExchangeRateHttpClient } from '../ExchangeRateHttpClient'
import { FetchedRate, IExchangeRateProvider } from './IExchangeRateProvider'
import { FxSource } from '../interfaces/IFxRateService'

/**
 * Frankfurter — provedor primário.
 *
 * Escolhido não por ser gratuito, mas por ser **open source e auto-hospedável
 * com Docker**: se o serviço público sair do ar ou mudar de política, sobe-se o
 * nosso sem trocar uma linha daqui. Dados de referência do BCE.
 *
 * ⚠ Publica em dia útil, uma vez ao dia. Fim de semana e feriado repetem a
 * última cotação — por isso `rateDate` vem da resposta e não de `new Date()`.
 */
const responseSchema = z.object({
  // O corpo traz mais campos; `strict` não é usado de propósito para o provedor
  // poder acrescentar coisas sem quebrar a coleta.
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

    // Validar o corpo é o que separa "o provedor mudou o formato" de "a taxa é
    // zero". Sem isto, um campo ausente viraria NaN e seguiria adiante.
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
