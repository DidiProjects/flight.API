import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FlightFaresService } from './FlightFaresService'
import type { CurrentBest, IFlightFaresRepository } from './interfaces/IFlightFaresRepository'
import type { IFxRateService } from '../../services/fx/interfaces/IFxRateService'

const GBP_BRL = 6.8
const EUR_BRL = 6.0

function makeSvc(current: Partial<CurrentBest>) {
  const repo = {
    getCurrentBest: vi.fn().mockResolvedValue({
      currency: 'BRL', best_cash: null, best_pts: null, best_hyb_pts: null, best_hyb_cash: null,
      scraped_at: new Date(), ...current,
    }),
    getSummary: vi.fn().mockResolvedValue({
      currency: null, avg_cash_30d: null, min_cash_30d: null,
      p20_cash_30d: null, avg_pts_30d: null, min_pts_30d: null,
    }),
  } as unknown as IFlightFaresRepository

  const emBrl = (v: number, c: string) => (c === 'BRL' ? v : c === 'GBP' ? v * GBP_BRL : v * EUR_BRL)
  const fx = {
    convert: vi.fn(async (amount: number, from: string, to: string) => {
      if (from === to) return { amount, rate: 1, source: 'native' as const, rateDate: '2026-08-04', stale: false }
      if (!['BRL', 'GBP', 'EUR'].includes(from) || !['BRL', 'GBP', 'EUR'].includes(to)) return null
      const v = emBrl(amount, from) / emBrl(1, to)
      return { amount: Math.round(v * 100) / 100, rate: v / amount, source: 'frankfurter' as const, rateDate: '2026-08-04', stale: false }
    }),
    toBrl: vi.fn(),
  } as unknown as IFxRateService

  return { svc: new FlightFaresService(repo, fx), fx }
}

const RT = { from: '2026-09-25', to: '2026-09-25' }

describe('FlightFaresService — total do par', () => {
  it('soma direto quando as duas pernas já estão na mesma moeda', async () => {
    const { svc } = makeSvc({ currency: 'BRL', best_cash_outbound: 4921, best_cash_inbound: 7627 })

    const out = await svc.getCurrent(['britishairways'], 'GRU', 'LHR', '2026-09-21', '2026-09-21', RT)

    expect(out.best_cash).toBe(12548)
    expect(out.currency).toBe('BRL')
  })

  it('converte a volta para a moeda da IDA', async () => {
    // £100 de ida + €60 de volta. €60 = R$360 = £52,94 ⇒ total £152,94.
    const { svc } = makeSvc({ currency: 'GBP', best_cash_outbound: 100, best_cash_inbound: 60 })
    const { svc: svcEur } = makeSvc({ currency: 'EUR', best_cash_outbound: 60, best_cash_inbound: 100 })

    const emLibra = await svc.getCurrent(['ryanair'], 'STN', 'DUB', '2026-09-21', '2026-09-21', RT)
    expect(emLibra.currency).toBe('GBP')

    // A mesma viagem vista da outra ponta fecha na moeda da OUTRA ida — é o que
    // "sempre a moeda da tarifa de origem" significa.
    const emEuro = await svcEur.getCurrent(['ryanair'], 'DUB', 'STN', '2026-09-21', '2026-09-21', RT)
    expect(emEuro.currency).toBe('EUR')
  })

  it('a moeda do total é sempre a da ida, nunca a da volta', async () => {
    const { svc } = makeSvc({ currency: 'GBP', best_cash_outbound: 100, best_cash_inbound: 60 })

    const out = await svc.getCurrent(['ryanair'], 'STN', 'DUB', '2026-09-21', '2026-09-21', RT)

    expect(out.currency).toBe('GBP')
    expect(out.journeys[0]!.direction).toBe('outbound')
    expect(out.journeys[0]!.currency).toBe('GBP')
  })

  it('sem cotação confiável, omite o total em vez de somar moedas', async () => {
    const { svc, fx } = makeSvc({ currency: 'GBP', best_cash_outbound: 100, best_cash_inbound: 60 })
    vi.mocked(fx.convert).mockResolvedValue(null)

    const out = await svc.getCurrent(['ryanair'], 'STN', 'DUB', '2026-09-21', '2026-09-21', RT)

    // O que veio do SQL permanece; o que não pode acontecer é somar £ com €.
    expect(out.best_cash).toBeNull()
  })

  it('rotina só-ida não tem total de par', async () => {
    const { svc, fx } = makeSvc({ currency: 'BRL', best_cash: 4921 })

    const out = await svc.getCurrent(['azul'], 'GRU', 'CNF', '2026-09-21', '2026-09-21')

    expect(out.journeys).toHaveLength(1)
    expect(out.best_cash).toBe(4921)
    expect(fx.convert).not.toHaveBeenCalled()
  })

  it('bundle da companhia (sem parcelas) não vira total inventado', async () => {
    // Preço único publicado pela companhia: as parcelas vêm nulas de propósito,
    // e dividir o bundle mostraria um número que ela nunca ofereceu.
    const { svc } = makeSvc({
      currency: 'BRL', best_cash: 9000, best_cash_outbound: null, best_cash_inbound: null,
    })

    const out = await svc.getCurrent(['azul'], 'GRU', 'CNF', '2026-09-21', '2026-09-21', RT)

    expect(out.best_cash).toBe(9000)
  })

  it('NUMERIC como string do pg não vira concatenação', async () => {
    // "4921.00" + "7627.00" = "4921.007627.00" → NaN → null no JSON, e o total
    // sumia do card. Foi assim que apareceu ao chamar a API de verdade.
    const { svc } = makeSvc({
      currency: 'BRL',
      best_cash_outbound: '4921.00' as unknown as number,
      best_cash_inbound:  '7627.00' as unknown as number,
    })

    const out = await svc.getCurrent(['britishairways'], 'GRU', 'LHR', '2026-09-21', '2026-09-21', RT)

    expect(out.best_cash).toBe(12548)
  })
})
