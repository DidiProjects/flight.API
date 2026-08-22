import { describe, it, expect } from 'vitest'
import { ExchangeRateHttpClient } from './ExchangeRateHttpClient'
import { FrankfurterProvider } from './providers/FrankfurterProvider'
import { CurrencyApiProvider } from './providers/CurrencyApiProvider'
import { FxRateService } from './FxRateService'

// Hits the exchange APIs FOR REAL. The unit tests prove the policy (cache, circuit
// breaker, sanity range); this one proves the only thing they cannot — that the
// external contract is still what we assume.
//
// Skipped by default: network in a unit suite holds CI hostage to a third party.
//
// To run:  FX_NETWORK_TEST=1 npx vitest run src/services/fx/FxRateService.network.test.ts

const describeIt = process.env['FX_NETWORK_TEST'] === '1' ? describe : describe.skip

const http = new ExchangeRateHttpClient(10_000)

// The vitest default is 5s, and there are two serial network calls in one test
// here. A short timeout would turn network jitter into "the contract changed".
describeIt('câmbio contra as APIs reais', { timeout: 30_000 }, () => {
  it('Frankfurter devolve GBP→BRL numa faixa plausível', async () => {
    const { rate, rateDate } = await new FrankfurterProvider(http).fetchToBrl('GBP')

    // The range is wide on purpose: the test is of the CONTRACT, not of the rate. It
    // fails when the format changes or the scale flips (6.8 → 0.0068), not when the
    // pound moves.
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
    // A large divergence between independent sources is the signal that one of them
    // broke in a way the schema does not catch.
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
