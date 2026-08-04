import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FxRateService } from './FxRateService'
import { ExchangeRateHttpClient } from './ExchangeRateHttpClient'
import { FrankfurterProvider } from './providers/FrankfurterProvider'
import { CurrencyApiProvider } from './providers/CurrencyApiProvider'
import type { IExchangeRateProvider } from './providers/IExchangeRateProvider'
import type { FxSource } from './interfaces/IFxRateService'

vi.mock('../../utils/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

/** Provedor de mentira, para exercitar a POLÍTICA sem tocar na rede. */
function fakeProvider(source: FxSource, impl: () => Promise<{ rate: number; rateDate: string }>): IExchangeRateProvider {
  return { source, fetchToBrl: vi.fn(impl) }
}

const FIXED_NOW = () => new Date('2026-08-04T12:00:00Z')

describe('FxRateService — conversão', () => {
  it('BRL não vai à rede: taxa 1, source native', async () => {
    // O caminho mais comum do sistema não pode depender de um terceiro estar
    // de pé.
    const p = fakeProvider('frankfurter', async () => { throw new Error('não deveria ser chamado') })
    const svc = new FxRateService([p], FIXED_NOW)

    const out = await svc.toBrl(1234.56, 'BRL')

    expect(out).toMatchObject({ amount: 1234.56, rate: 1, source: 'native', stale: false })
    expect(p.fetchToBrl).not.toHaveBeenCalled()
  })

  it('converte e arredonda para centavos', async () => {
    const svc = new FxRateService(
      [fakeProvider('frankfurter', async () => ({ rate: 6.8261, rateDate: '2026-08-03' }))],
      FIXED_NOW,
    )

    const out = await svc.toBrl(730, 'GBP')

    expect(out).toMatchObject({ amount: 4983.05, rate: 6.8261, source: 'frankfurter', rateDate: '2026-08-03', stale: false })
  })

  it('a data devolvida é a DA COTAÇÃO, não a de hoje', async () => {
    // O BCE publica em dia útil: no sábado a cotação boa é a de sexta, e dizer
    // "hoje" seria mentira no e-mail que explica o alerta.
    const svc = new FxRateService(
      [fakeProvider('frankfurter', async () => ({ rate: 6.8, rateDate: '2026-07-31' }))],
      FIXED_NOW,
    )

    expect((await svc.toBrl(100, 'GBP'))!.rateDate).toBe('2026-07-31')
  })

  it('recusa moeda malformada sem ir à rede', async () => {
    const p = fakeProvider('frankfurter', async () => ({ rate: 6.8, rateDate: '2026-08-03' }))
    const svc = new FxRateService([p], FIXED_NOW)

    expect(await svc.toBrl(100, 'REAIS')).toBeNull()
    expect(await svc.toBrl(100, '')).toBeNull()
    expect(p.fetchToBrl).not.toHaveBeenCalled()
  })
})

describe('FxRateService — faixa de sanidade', () => {
  // A única proteção contra falha SILENCIOSA: as outras estouram barulhento,
  // uma cotação absurda vira e-mail de "preço caiu" sem ninguém perceber.
  it.each([
    ['zero', 0],
    ['negativa', -6.8],
    ['infinita', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['ordem de grandeza errada (libra a 0,0068)', 0.0000068],
    ['absurdamente alta', 99_999_999],
  ])('recusa cotação %s e cai para o próximo provedor', async (_nome, rate) => {
    const ruim = fakeProvider('frankfurter', async () => ({ rate, rateDate: '2026-08-03' }))
    const bom  = fakeProvider('currency-api', async () => ({ rate: 6.8, rateDate: '2026-08-03' }))
    const svc = new FxRateService([ruim, bom], FIXED_NOW)

    const out = await svc.toBrl(100, 'GBP')

    expect(out).toMatchObject({ source: 'currency-api', rate: 6.8 })
  })

  it('sem provedor são, devolve null em vez de número duvidoso', async () => {
    const svc = new FxRateService(
      [fakeProvider('frankfurter', async () => ({ rate: 0, rateDate: '2026-08-03' }))],
      FIXED_NOW,
    )

    expect(await svc.toBrl(100, 'GBP')).toBeNull()
  })
})

describe('FxRateService — fallback e cache', () => {
  it('primária fora do ar: o fallback assume e o source reflete', async () => {
    const svc = new FxRateService([
      fakeProvider('frankfurter', async () => { throw new Error('ECONNREFUSED') }),
      fakeProvider('currency-api', async () => ({ rate: 6.8, rateDate: '2026-08-04' })),
    ], FIXED_NOW)

    expect((await svc.toBrl(100, 'GBP'))!.source).toBe('currency-api')
  })

  it('segunda conversão do mesmo dia sai do cache, sem nova chamada', async () => {
    const p = fakeProvider('frankfurter', async () => ({ rate: 6.8, rateDate: '2026-08-04' }))
    const svc = new FxRateService([p], FIXED_NOW)

    await svc.toBrl(100, 'GBP')
    await svc.toBrl(200, 'GBP')

    expect(p.fetchToBrl).toHaveBeenCalledOnce()
  })

  it('cache é por moeda: EUR não reaproveita a taxa da GBP', async () => {
    const p = fakeProvider('frankfurter', async () => ({ rate: 6.8, rateDate: '2026-08-04' }))
    const svc = new FxRateService([p], FIXED_NOW)

    await svc.toBrl(100, 'GBP')
    await svc.toBrl(100, 'EUR')

    expect(p.fetchToBrl).toHaveBeenCalledTimes(2)
  })

  it('virou o dia: busca de novo', async () => {
    let agora = new Date('2026-08-04T12:00:00Z')
    const p = fakeProvider('frankfurter', async () => ({ rate: 6.8, rateDate: '2026-08-04' }))
    const svc = new FxRateService([p], () => agora)

    await svc.toBrl(100, 'GBP')
    agora = new Date('2026-08-05T09:00:00Z')
    await svc.toBrl(100, 'GBP')

    expect(p.fetchToBrl).toHaveBeenCalledTimes(2)
  })

  it('todos fora do ar com cache velho: entrega marcando stale', async () => {
    let agora = new Date('2026-08-04T12:00:00Z')
    let falhar = false
    const p = fakeProvider('frankfurter', async () => {
      if (falhar) throw new Error('fora do ar')
      return { rate: 6.8, rateDate: '2026-08-04' }
    })
    const svc = new FxRateService([p], () => agora)

    await svc.toBrl(100, 'GBP')
    agora = new Date('2026-08-05T09:00:00Z')
    falhar = true

    const out = await svc.toBrl(100, 'GBP')
    // Número velho é melhor que nada, mas quem chama precisa SABER que é velho.
    expect(out).toMatchObject({ rate: 6.8, stale: true })
  })

  it('todos fora do ar e sem cache: null', async () => {
    const svc = new FxRateService([
      fakeProvider('frankfurter', async () => { throw new Error('fora') }),
      fakeProvider('currency-api', async () => { throw new Error('fora') }),
    ], FIXED_NOW)

    expect(await svc.toBrl(100, 'GBP')).toBeNull()
  })
})

describe('FxRateService — disjuntor', () => {
  it('após 3 falhas seguidas, para de chamar o provedor', async () => {
    const ruim = fakeProvider('frankfurter', async () => { throw new Error('fora') })
    const bom  = fakeProvider('currency-api', async () => ({ rate: 6.8, rateDate: '2026-08-04' }))
    const svc = new FxRateService([ruim, bom], FIXED_NOW)

    // Moedas diferentes para não cair no cache e exercitar o provedor de novo.
    await svc.toBrl(100, 'GBP')
    await svc.toBrl(100, 'EUR')
    await svc.toBrl(100, 'USD')
    expect(ruim.fetchToBrl).toHaveBeenCalledTimes(3)

    await svc.toBrl(100, 'CHF')
    // A quarta não chega nele: martelar quem está fora do ar só gasta o
    // orçamento de tempo do ciclo de avaliação.
    expect(ruim.fetchToBrl).toHaveBeenCalledTimes(3)
  })

  it('passado o descanso, volta a tentar', async () => {
    let agora = new Date('2026-08-04T12:00:00Z')
    const ruim = fakeProvider('frankfurter', async () => { throw new Error('fora') })
    const bom  = fakeProvider('currency-api', async () => ({ rate: 6.8, rateDate: '2026-08-04' }))
    const svc = new FxRateService([ruim, bom], () => agora)

    await svc.toBrl(100, 'GBP')
    await svc.toBrl(100, 'EUR')
    await svc.toBrl(100, 'USD')
    await svc.toBrl(100, 'CHF')
    expect(ruim.fetchToBrl).toHaveBeenCalledTimes(3)

    agora = new Date('2026-08-04T12:06:00Z')
    await svc.toBrl(100, 'DKK')
    expect(ruim.fetchToBrl).toHaveBeenCalledTimes(4)
  })

  it('sucesso zera o contador de falhas', async () => {
    let falhar = true
    const p = fakeProvider('frankfurter', async () => {
      if (falhar) throw new Error('instável')
      return { rate: 6.8, rateDate: '2026-08-04' }
    })
    const svc = new FxRateService([p], FIXED_NOW)

    await svc.toBrl(100, 'GBP')
    await svc.toBrl(100, 'EUR')
    falhar = false
    await svc.toBrl(100, 'USD')
    falhar = true

    // Duas falhas + sucesso + duas falhas não deveria abrir o disjuntor: o
    // sucesso no meio diz que o provedor está vivo, só instável.
    await svc.toBrl(100, 'CHF')
    await svc.toBrl(100, 'DKK')
    await svc.toBrl(100, 'NOK')
    expect(p.fetchToBrl).toHaveBeenCalledTimes(6)
  })
})

describe('ExchangeRateHttpClient — allowlist', () => {
  it('aceita só os hosts previstos, e só em HTTPS', () => {
    expect(ExchangeRateHttpClient.isAllowed('https://api.frankfurter.dev/v1/latest?base=GBP')).toBe(true)
    expect(ExchangeRateHttpClient.isAllowed('https://cdn.jsdelivr.net/npm/x.json')).toBe(true)

    // Em texto claro a cotação pode ser trocada em trânsito, e taxa adulterada
    // vira decisão de alerta.
    expect(ExchangeRateHttpClient.isAllowed('http://api.frankfurter.dev/v1/latest')).toBe(false)
  })

  it('recusa host interno — é o alvo clássico de SSRF', () => {
    expect(ExchangeRateHttpClient.isAllowed('https://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(ExchangeRateHttpClient.isAllowed('https://localhost:5432/')).toBe(false)
    expect(ExchangeRateHttpClient.isAllowed('https://flight-db/')).toBe(false)
  })

  it('recusa host que só PARECE permitido', () => {
    expect(ExchangeRateHttpClient.isAllowed('https://api.frankfurter.dev.evil.com/v1')).toBe(false)
    expect(ExchangeRateHttpClient.isAllowed('https://evil.com/api.frankfurter.dev')).toBe(false)
  })

  it('recusa URL inválida em vez de estourar', () => {
    expect(ExchangeRateHttpClient.isAllowed('não é url')).toBe(false)
    expect(ExchangeRateHttpClient.isAllowed('')).toBe(false)
  })

  it('não abre conexão para host recusado', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = new ExchangeRateHttpClient()

    await expect(client.getJson('https://evil.com/rates.json')).rejects.toThrow(/não permitido/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('providers — validação da resposta', () => {
  const httpQueDevolve = (body: unknown) =>
    ({ getJson: vi.fn().mockResolvedValue(body) }) as unknown as ExchangeRateHttpClient

  it('Frankfurter: lê a taxa e a data', async () => {
    const p = new FrankfurterProvider(httpQueDevolve({ amount: 1, base: 'GBP', date: '2026-08-03', rates: { BRL: 6.8261 } }))
    expect(await p.fetchToBrl('GBP')).toEqual({ rate: 6.8261, rateDate: '2026-08-03' })
  })

  it('Frankfurter: corpo fora do formato vira erro, não NaN', async () => {
    // Sem o schema, `rates.BRL` ausente viraria undefined → NaN → e seguiria
    // adiante como se fosse número.
    const p = new FrankfurterProvider(httpQueDevolve({ date: '2026-08-03' }))
    await expect(p.fetchToBrl('GBP')).rejects.toThrow(/formato/)

    const p2 = new FrankfurterProvider(httpQueDevolve({ date: '2026-08-03', rates: { USD: 1.2 } }))
    await expect(p2.fetchToBrl('GBP')).rejects.toThrow(/sem cotação/)
  })

  it('currency-api: lê a taxa da tabela da moeda de origem', async () => {
    const p = new CurrencyApiProvider(httpQueDevolve({ date: '2026-08-04', gbp: { brl: 6.82, usd: 1.27 } }))
    expect(await p.fetchToBrl('GBP')).toEqual({ rate: 6.82, rateDate: '2026-08-04' })
  })

  it('currency-api: recusa código que não seja três letras', async () => {
    // A moeda vem do banco; montar caminho de URL com valor não sanitizado é
    // como se atravessa uma allowlist de host por path traversal.
    const http = httpQueDevolve({ date: '2026-08-04' })
    const p = new CurrencyApiProvider(http)

    await expect(p.fetchToBrl('../../etc/passwd')).rejects.toThrow(/inválido/)
    expect(http.getJson).not.toHaveBeenCalled()
  })
})
