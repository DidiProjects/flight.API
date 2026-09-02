import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvaluationService } from './EvaluationService'
import type { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import type { IFlightFaresRepository, LatestFaresByDate, PairFareRow } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import type { ITargetAlertStateRepository, AlertWatermark, WatermarkState } from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
import type { INotificationsService } from '../notifications/interfaces/INotificationsService'
import type { IFxRateService } from '../fx/interfaces/IFxRateService'
import type { RoutineRow } from '../../types/index'

vi.mock('../../utils/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

/**
 * The margin widens the target; it must not multiply it.
 *
 * Reproduces the production alert of 2026-08-31 on the "Natal no Brasil" routine:
 * target R$7,000, margin 0.1, and an e-mail announcing a pair of R$8,374.95 as
 * within target. The pair was real and correctly converted — BA247 (£558) plus
 * BA246 (£636) at 7.0142 — it simply was not within R$7,700.
 *
 * The rate here is the production one, so the numbers below are the ones the user
 * received.
 */
const GBP = 7.0142
const IDA = '2026-12-06'
const VOLTA = '2027-01-10'

function makeRoutine(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    id: 'rot-natal', user_id: 'u1', name: 'Natal no Brasil', airlines: ['britishairways'],
    origin: 'LHR', destination: 'GRU',
    outbound_start: IDA, outbound_end: IDA,
    trip_type: 'round_trip', inbound_start: VOLTA, inbound_end: VOLTA,
    passengers: 2, currency: 'BRL',
    target_cash: 7000, target_pts: null, target_hyb_pts: null, target_hyb_cash: null,
    margin: 0.1, priority: 'cash',
    notification_modes: ['target'], notification_frequency: 'hourly', scheduled_time: null,
    cc_emails: [], is_active: true, created_at: new Date(), updated_at: new Date(),
    ...over,
  } as RoutineRow
}

/** Um par ida-e-volta como o `getLatestPairs` devolve: as duas pernas da mesma corrida. */
function par(idaGbp: number, voltaGbp: number): PairFareRow[] {
  const base = {
    airline: 'britishairways', request_id: 'req-1',
    return_date: VOLTA, pair_outbound_date: IDA,
    currency: 'GBP', fare_pts: null, fare_hyb_pts: null, fare_hyb_cash: null,
    bundle_cash: null, bundle_pts: null, bundle_hyb_pts: null, bundle_hyb_cash: null,
    departure_time: '10:00', arrival_time: '20:00', duration_min: 700, stops: 0,
    inbound_unavailable: false, scraped_at: new Date(),
  }
  return [
    { ...base, is_return: false, origin: 'LHR', destination: 'GRU', flight_date: IDA,
      flight_number: 'BA247', paired_outbound_flight: null, fare_cash: idaGbp },
    { ...base, is_return: true, origin: 'GRU', destination: 'LHR', flight_date: VOLTA,
      flight_number: 'BA246', paired_outbound_flight: 'BA247', fare_cash: voltaGbp },
  ] as unknown as PairFareRow[]
}

describe('EvaluationService — a margem alarga o alvo, não o multiplica', () => {
  let routinesRepo: IRoutinesRepository
  let faresRepo: IFlightFaresRepository
  let alertRepo: ITargetAlertStateRepository
  let notifSvc: INotificationsService
  let fx: IFxRateService
  let svc: EvaluationService

  beforeEach(() => {
    routinesRepo = { findAllActive: vi.fn().mockResolvedValue([]) } as unknown as IRoutinesRepository
    faresRepo = {
      getLatestByRoute: vi.fn().mockResolvedValue([] as LatestFaresByDate[]),
      getLatestPairs:   vi.fn().mockResolvedValue([]),
      getPriceHistory:  vi.fn().mockResolvedValue({ currency: 'BRL' }),
    } as unknown as IFlightFaresRepository
    alertRepo = {
      getWatermarks:  vi.fn().mockResolvedValue(new Map<string, WatermarkState>()),
      recordNotified: vi.fn().mockImplementation(
        async (_r: string, _f: string, e: AlertWatermark[]) => new Set(e.map((x) => x.flightDate)),
      ),
      cleanupPastDates: vi.fn().mockResolvedValue(0),
    } as unknown as ITargetAlertStateRepository
    notifSvc = { dispatchAlert: vi.fn().mockResolvedValue(undefined) } as unknown as INotificationsService
    fx = {
      toBrl: vi.fn(async (amount: number, currency: string) => {
        if (currency === 'BRL') return { amount, rate: 1, source: 'native' as const, rateDate: '2026-08-31', stale: false }
        if (currency === 'GBP') return { amount: Math.round(amount * GBP * 100) / 100, rate: GBP, source: 'frankfurter' as const, rateDate: '2026-08-31', stale: false }
        return null
      }),
    } as unknown as IFxRateService

    svc = new EvaluationService(routinesRepo, faresRepo, alertRepo, notifSvc, fx)
  })

  const rodar = async (routine: RoutineRow, pares: PairFareRow[]) => {
    vi.mocked(routinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(faresRepo.getLatestPairs).mockResolvedValue(pares)
    await svc.runCycle()
  }

  it('o par de R$8.374,95 NÃO alerta com alvo 7.000 e margem 0,1', async () => {
    // £558 → 3.913,92 e £636 → 4.461,03. Total 8.374,95, contra teto de 7.700.
    // Era exatamente este e-mail que chegava em produção.
    await rodar(makeRoutine(), par(558, 636))

    expect(notifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('dentro do teto continua alertando, com o total convertido', async () => {
    // £500 → 3.507,10 e £590 → 4.138,38. Total 7.645,48, abaixo dos 7.700.
    await rodar(makeRoutine(), par(500, 590))

    expect(notifSvc.dispatchAlert).toHaveBeenCalledOnce()
    const gravado = vi.mocked(alertRepo.recordNotified).mock.calls[0]![2]
    expect(gravado[0]!.amount).toBeCloseTo(7645.48, 2)
  })

  it('margem zero significa o alvo exato, não dez vezes ele', async () => {
    // £500 + £590 = 7.645,48 > 7.000. Com a margem concatenando, o teto virava
    // 7.000 × "10" e este par passava.
    await rodar(makeRoutine({ margin: 0 }), par(500, 590))

    expect(notifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('a margem é somada, não anexada: 0,2 sobre 7.000 dá 8.400', async () => {
    // O mesmo par de 8.374,95 que falha com 0,1 tem de passar com 0,2 — é a prova
    // de que a margem alarga o alvo de forma proporcional.
    await rodar(makeRoutine({ margin: 0.2 }), par(558, 636))

    expect(notifSvc.dispatchAlert).toHaveBeenCalledOnce()
  })
})
