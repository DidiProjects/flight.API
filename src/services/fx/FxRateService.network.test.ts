import { describe, it, expect } from 'vitest'
import { ExchangeRateHttpClient } from './ExchangeRateHttpClient'
import { FrankfurterProvider } from './providers/FrankfurterProvider'
import { CurrencyApiProvider } from './providers/CurrencyApiProvider'
import { FxRateService } from './FxRateService'

// Bate nas APIs de câmbio DE VERDADE. Os testes unitários provam a política
// (cache, disjuntor, faixa de sanidade); este prova a única coisa que eles não
// podem provar — que o contrato externo continua sendo o que assumimos.
//
// Pulado por padrão: rede em suíte de unidade deixa o CI refém de terceiro.
//
// Rodar:  FX_NETWORK_TEST=1 npx vitest run src/services/fx/FxRateService.network.test.ts

const describeIt = process.env['FX_NETWORK_TEST'] === '1' ? describe : describe.skip

const http = new ExchangeRateHttpClient(10_000)

// O default do vitest é 5s, e aqui há duas chamadas de rede em série num mesmo
// teste. Timeout curto transformaria oscilação de rede em "o contrato mudou".
describeIt('câmbio contra as APIs reais', { timeout: 30_000 }, () => {
  it('Frankfurter devolve GBP→BRL numa faixa plausível', async () => {
    const { rate, rateDate } = await new FrankfurterProvider(http).fetchToBrl('GBP')

    // Faixa larga de propósito: o teste é do CONTRATO, não do câmbio. Ele falha
    // quando o formato muda ou a escala vira (6,8 → 0,0068), não quando a libra
    // oscila.
    expect(rate).toBeGreaterThan(3)
    expect(rate).toBeLessThan(15)
    expect(rateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('currency-api (fallback) devolve GBP→BRL na mesma ordem de grandeza', async () => {
    const { rate, rateDate } = await new CurrencyApiProvider(http).fetchToBrl('GBP')

    expect(rate).toBeGreaterThan(3)
    expect(rate).toBeLessThan(15)
    expect(rateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('os dois provedores concordam dentro de 5%', async () => {
    // Divergência grande entre fontes independentes é o sinal de que uma delas
    // quebrou de um jeito que o schema não pega.
    const [a, b] = await Promise.all([
      new FrankfurterProvider(http).fetchToBrl('GBP'),
      new CurrencyApiProvider(http).fetchToBrl('GBP'),
    ])

    const diff = Math.abs(a.rate - b.rate) / a.rate
    expect(diff).toBeLessThan(0.05)
  })

  it('as moedas que os scrapers produzem hoje têm cotação', async () => {
    const svc = new FxRateService([new FrankfurterProvider(http), new CurrencyApiProvider(http)])

    for (const currency of ['GBP', 'EUR', 'USD']) {
      const out = await svc.toBrl(100, currency)
      expect(out, `sem cotação para ${currency}`).not.toBeNull()
      expect(out!.stale).toBe(false)
    }
  })

  it('BRL não vai à rede nem com provedor configurado', async () => {
    const svc = new FxRateService([new FrankfurterProvider(http)])
    expect(await svc.toBrl(100, 'BRL')).toMatchObject({ amount: 100, rate: 1, source: 'native' })
  })
})
