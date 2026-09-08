import { describe, it, expect, vi } from 'vitest'
import { FlightFaresService } from './FlightFaresService'
import type { CurrentBest, IFlightFaresRepository, PriceByDate } from './interfaces/IFlightFaresRepository'

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

/**
 * `getPriceByDate` now returns one row PER (date, airline) — the repository
 * stopped collapsing across airlines (regression test moved here from
 * FlightFaresRepository.integration.test.ts: the SQL merge used to hide which
 * airline actually won, which is the whole point of a per-company calendar).
 */
function makeByDateSvc(rows: PriceByDate[]) {
  const repo = {
    getPriceByDate: vi.fn().mockResolvedValue(rows),
  } as unknown as IFlightFaresRepository
  return new FlightFaresService(repo)
}

/**
 * `flight_date` is a `date` column: pg gives back a `Date` object, never the
 * string the type declares. A literal string here would hide exactly the bug
 * this fixture reproduces (`a.localeCompare is not a function`, caught only in
 * the browser against the real API — the mock had been lying about the type).
 */
function dbDate(iso: string): string {
  return new Date(iso) as unknown as string
}

describe('FlightFaresService — calendário por data', () => {
  it('dates funde as companhias pela MAIS BARATA, por data', async () => {
    const svc = makeByDateSvc([
      { airline: 'azul', flight_date: dbDate('2026-07-12'), best_cash: 900, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
      { airline: 'latam', flight_date: dbDate('2026-07-12'), best_cash: 1500, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
    ])

    const out = await svc.getByDate(['azul', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

    expect(out.dates).toHaveLength(1)
    expect(out.dates[0]!.flight_date).toBe('2026-07-12')
    expect(out.dates[0]!.best_cash).toBe(900)
  })

  it('byAirline preserva o preço de CADA companhia, sem fundir', async () => {
    const svc = makeByDateSvc([
      { airline: 'azul', flight_date: dbDate('2026-07-12'), best_cash: 900, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
      { airline: 'latam', flight_date: dbDate('2026-07-12'), best_cash: 1500, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
    ])

    const out = await svc.getByDate(['azul', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

    const azul = out.byAirline.find((s) => s.airline === 'azul')
    const latam = out.byAirline.find((s) => s.airline === 'latam')
    expect(azul?.dates[0]?.best_cash).toBe(900)
    expect(latam?.dates[0]?.best_cash).toBe(1500)
  })

  it('duas datas distintas não se fundem numa só', async () => {
    // Regressão: usar o Date bruto como chave de Map (em vez do dia normalizado)
    // criava uma chave nova por instância — cada data virava seu próprio grupo,
    // OU (pior, se o objeto colidisse) duas datas diferentes se fundiam. O sort
    // por `.localeCompare` também quebrava, porque a chave nunca era string.
    const svc = makeByDateSvc([
      { airline: 'azul', flight_date: dbDate('2026-07-12'), best_cash: 900, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
      { airline: 'azul', flight_date: dbDate('2026-07-13'), best_cash: 800, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
    ])

    const out = await svc.getByDate(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

    expect(out.dates.map((d) => d.flight_date)).toEqual(['2026-07-12', '2026-07-13'])
  })

  it('NUMERIC como string do pg vira número, em dates e em byAirline', async () => {
    const svc = makeByDateSvc([
      { airline: 'azul', flight_date: dbDate('2026-07-12'), best_cash: '900.00' as unknown as number, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
    ])

    const out = await svc.getByDate(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

    expect(out.dates[0]!.best_cash).toBe(900)
    expect(out.byAirline[0]!.dates[0]!.best_cash).toBe(900)
  })

  it('companhia sem nenhuma data coletada não aparece em byAirline', async () => {
    const svc = makeByDateSvc([
      { airline: 'azul', flight_date: dbDate('2026-07-12'), best_cash: 900, best_pts: null, best_hyb_pts: null, best_hyb_cash: null },
    ])

    const out = await svc.getByDate(['azul', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

    expect(out.byAirline.map((s) => s.airline)).toEqual(['azul'])
  })
})
