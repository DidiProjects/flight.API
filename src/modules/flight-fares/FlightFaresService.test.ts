import { describe, it, expect, vi } from 'vitest'
import { FlightFaresService } from './FlightFaresService'
import type { CurrentBest, IFlightFaresRepository } from './interfaces/IFlightFaresRepository'

/**
 * Since 017 the read path does NOT convert currency.
 *
 * Conversion happens once, at analysis ingestion, with the rate stored on the row
 * — and the pair total arrives here already summed in Real by the SQL. The service
 * no longer receives `IFxRateService`: the absence of network in this layer is now
 * guaranteed by the constructor, not by discipline.
 */
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

  return { svc: new FlightFaresService(repo), repo }
}

const RT = { from: '2026-09-25', to: '2026-09-25' }

describe('FlightFaresService — total do par', () => {
  it('o total vem pronto do SQL, em Real', async () => {
    const { svc } = makeSvc({ currency: 'BRL', best_cash: 12548, best_cash_outbound: 4921, best_cash_inbound: 7627 })

    const out = await svc.getCurrent(['britishairways'], 'GRU', 'LHR', '2026-09-21', '2026-09-21', RT)

    expect(out.best_cash).toBe(12548)
    expect(out.currency).toBe('BRL')
  })

  it('par com pernas de mercados diferentes tem total, e em Real', async () => {
    // BA out of LHR falls into two one-way searches: outbound in GBP, return in BRL.
    // That is exactly the pair the `i.currency = o.currency` guard discarded, leaving
    // history and best price empty. With conversion stored at collection, the SQL sums
    // and the total exists.
    const { svc } = makeSvc({ currency: 'BRL', best_cash: 10876, best_cash_outbound: 5115, best_cash_inbound: 5761 })

    const out = await svc.getCurrent(['britishairways'], 'LHR', 'GRU', '2026-12-05', '2026-12-06', RT)

    expect(out.best_cash).toBe(10876)
    expect(out.currency).toBe('BRL')
    expect(out.journeys).toHaveLength(2)
  })

  it('rotina só-ida devolve uma jornada e o valor da perna', async () => {
    const { svc } = makeSvc({ currency: 'BRL', best_cash: 4921 })

    const out = await svc.getCurrent(['azul'], 'GRU', 'CNF', '2026-09-21', '2026-09-21')

    expect(out.journeys).toHaveLength(1)
    expect(out.best_cash).toBe(4921)
  })

  it('sem valor em Real o total é nulo, nunca uma soma de moedas', async () => {
    // A leg with no quote at collection goes in with fare_cash_brl NULL, and the SQL
    // sum turns NULL. The card shows the parts and omits the total.
    const { svc } = makeSvc({ currency: 'BRL', best_cash: null, best_cash_outbound: 5115, best_cash_inbound: null })

    const out = await svc.getCurrent(['britishairways'], 'LHR', 'GRU', '2026-12-05', '2026-12-06', RT)

    expect(out.best_cash).toBeNull()
  })

  it('NUMERIC como string do pg vira número', async () => {
    // "12548.00" leaving in the JSON makes any comparison on the front turn
    // lexicographic. pairTotal used to coerce while summing; with the sum in SQL the
    // coercion became explicit.
    const { svc } = makeSvc({
      currency: 'BRL',
      best_cash: '12548.00' as unknown as number,
      best_cash_outbound: '4921.00' as unknown as number,
      best_cash_inbound:  '7627.00' as unknown as number,
    })

    const out = await svc.getCurrent(['britishairways'], 'GRU', 'LHR', '2026-09-21', '2026-09-21', RT)

    expect(out.best_cash).toBe(12548)
    expect(out.journeys[0]!.cash).toBe(4921)
    expect(out.journeys[1]!.cash).toBe(7627)
  })
})
