import { describe, it, expect, vi } from 'vitest'
import { NotificationsService } from './NotificationsService'
import type { RoutineRow } from '../../types'

/**
 * What this protects: a Brazil↔London routine used to vanish from the daily summary.
 *
 * The evaluation cycle dropped the "both legs in the same currency" guard when the
 * conversion arrived — the pair whose outbound is charged in Real and whose return is
 * charged in pounds is the ordinary shape of that route, not corrupt data. The summary
 * kept the guard: it discarded every pair, concluded there was no fare, and skipped the
 * routine entirely. The user saw 2 of his 5 active routines in the e-mail.
 */

function pairRow(over: Record<string, unknown>) {
  return {
    airline: 'britishairways', origin: 'GRU', destination: 'LHR',
    flight_date: '2026-11-10', return_date: '2026-11-20',
    is_return: false, currency: 'BRL', fare_cash: 1000,
    fare_pts: null, fare_hyb_pts: null, fare_hyb_cash: null,
    bundle_cash: null, bundle_pts: null, bundle_hyb_pts: null, bundle_hyb_cash: null,
    flight_number: 'BA246', paired_outbound_flight: null, inbound_unavailable: false,
    departure_time: null, arrival_time: null, duration_min: null, stops: null,
    scraped_at: new Date(), request_id: 'r1', pair_outbound_date: '2026-11-10',
    ...over,
  }
}

const routine = {
  id: 'rot-1', user_id: 'u-1', name: 'GRU-LHR', origin: 'GRU', destination: 'LHR',
  trip_type: 'round_trip', priority: 'cash', passengers: 1,
  outbound_start: '2026-11-10', outbound_end: '2026-11-10',
  inbound_start: '2026-11-20', inbound_end: '2026-11-20',
  airlines: ['britishairways'], margin: 0.1, cc_emails: [],
} as unknown as RoutineRow

function build(rows: unknown[], fxOverride?: unknown) {
  const sendDailyBest = vi.fn()
  const svc = new NotificationsService(
    { findById: vi.fn().mockResolvedValue({ id: 'u-1', email: 'q@local.test' }) } as never,
    {} as never,
    { getLatestPairs: vi.fn().mockResolvedValue(rows), getLatestByRoute: vi.fn() } as never,
    { insert: vi.fn(), hasNotificationSinceHours: vi.fn() } as never,
    { create: vi.fn().mockResolvedValue('tok') } as never,
    { sendDailyBest } as never,
    (fxOverride ?? {
      // £1 = R$7, Real does not convert.
      toBrl: vi.fn(async (amount: number, currency: string) =>
        currency === 'BRL'
          ? { amount, rate: 1, source: 'native' as const, rateDate: '2026-09-02', stale: false }
          : { amount: amount * 7, rate: 7, source: 'frankfurter' as const, rateDate: '2026-09-02', stale: false }),
      convert: vi.fn(),
    }) as never,
    { API_BASE_URL: 'http://local' } as never,
  )
  return { svc, sendDailyBest }
}

describe('resumo diário: a ida e a volta são o mesmo par', () => {
  it('rotina ida-e-volta com as duas pernas em Real entra no resumo', async () => {
    const { svc, sendDailyBest } = build([
      pairRow({ currency: 'BRL', fare_cash: 4900, is_return: false }),
      pairRow({ currency: 'BRL', fare_cash: 3800, is_return: true, origin: 'LHR', destination: 'GRU', flight_date: '2026-11-20' }),
    ])

    expect(await svc.resendDailySummary(routine)).toBe(true)
    const arg = sendDailyBest.mock.calls[0]![0] as { routines: { airlineOffers: { return: unknown }[] }[] }
    expect(arg.routines[0]!.airlineOffers[0]!.return).not.toBeNull()
  })
})

describe('resumo diário: pernas em moedas diferentes', () => {
  it('a rotina Brasil↔Londres entra no resumo com ida em Real e volta em libra', async () => {
    const { svc, sendDailyBest } = build([
      pairRow({ currency: 'BRL', fare_cash: 4900, is_return: false }),
      pairRow({ currency: 'GBP', fare_cash: 730, is_return: true, origin: 'LHR', destination: 'GRU', flight_date: '2026-11-20' }),
    ])

    expect(await svc.resendDailySummary(routine)).toBe(true)
    expect(sendDailyBest).toHaveBeenCalledOnce()
  })

  it('a perna mais barata é escolhida em Real, não pelo número cru', async () => {
    // £730 vira R$5.110 e perde para a volta de R$4.000 — antes, 730 ganhava de 4000
    // por ser o número menor.
    const { svc, sendDailyBest } = build([
      pairRow({ currency: 'BRL', fare_cash: 1000, is_return: false }),
      pairRow({ currency: 'GBP', fare_cash: 730, is_return: true, origin: 'LHR', destination: 'GRU', flight_number: 'BA247' }),
      pairRow({ currency: 'BRL', fare_cash: 4000, is_return: true, origin: 'LHR', destination: 'GRU', flight_number: 'BA249' }),
    ])

    expect(await svc.resendDailySummary(routine)).toBe(true)
    const arg = sendDailyBest.mock.calls[0]![0] as { routines: { airlineOffers: { return: { flightNumber: string } | null }[] }[] }
    expect(arg.routines[0]!.airlineOffers[0]!.return).not.toBeNull()
  })

  it('sem cotação o par não entra: resumo com número duvidoso é pior que sem resumo', async () => {
    // Mesma regra do ciclo de avaliação. Sem a volta convertível não há par, e o
    // round trip não mostra a perna solta como se fosse o preço da viagem.
    const semCotacao = {
      toBrl: vi.fn(async (amount: number, currency: string) =>
        currency === 'BRL'
          ? { amount, rate: 1, source: 'native' as const, rateDate: '2026-09-02', stale: false }
          : null),
      convert: vi.fn(),
    }
    const { svc, sendDailyBest } = build([
      pairRow({ currency: 'BRL', fare_cash: 4900, is_return: false }),
      pairRow({ currency: 'XXX', fare_cash: 730, is_return: true, origin: 'LHR', destination: 'GRU', flight_date: '2026-11-20' }),
    ], semCotacao)

    expect(await svc.resendDailySummary(routine)).toBe(false)
    expect(sendDailyBest).not.toHaveBeenCalled()
  })
})
