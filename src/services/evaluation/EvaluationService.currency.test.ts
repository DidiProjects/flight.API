import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvaluationService } from './EvaluationService'
import type { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import type { IFlightFaresRepository, LatestFaresByDate } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import type {
  ITargetAlertStateRepository, AlertWatermark, WatermarkState, PriceBreakdown,
} from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
import type { INotificationsService } from '../notifications/interfaces/INotificationsService'
import type { IFxRateService } from '../fx/interfaces/IFxRateService'
import type { RoutineRow } from '../../types/index'

vi.mock('../../utils/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

/** Cotação fixa da libra, para os números do teste serem conferíveis à mão. */
const GBP = 6.8
const DATA = '2026-08-15'

function makeRoutine(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    id: 'rot-1', user_id: 'u1', name: 'teste', airlines: ['azul'],
    origin: 'GRU', destination: 'LHR',
    outbound_start: DATA, outbound_end: DATA,
    trip_type: 'one_way', inbound_start: null, inbound_end: null,
    passengers: 1, currency: 'BRL',
    target_cash: 5000, target_pts: null, target_hyb_pts: null, target_hyb_cash: null,
    margin: 0, priority: 'cash',
    notification_modes: ['target'], notification_frequency: 'hourly', scheduled_time: null,
    cc_emails: [], is_active: true, created_at: new Date(), updated_at: new Date(),
    ...over,
  } as RoutineRow
}

function makeFare(over: Partial<LatestFaresByDate> = {}): LatestFaresByDate {
  return {
    airline: 'azul', flight_date: DATA, is_return: false,
    departure_time: '06:00', arrival_time: '18:00', duration_min: 720, stops: 0,
    currency: 'BRL', fare_cash: 1800, fare_pts: null, fare_hyb_pts: null, fare_hyb_cash: null,
    scraped_at: new Date(),
    ...over,
  } as LatestFaresByDate
}

const leg = (currency: string, amount: number): PriceBreakdown =>
  ({ direction: 'outbound', currency, amount })

const watermark = (amount: number, breakdown: PriceBreakdown[] | null): Map<string, WatermarkState> =>
  new Map([[DATA, { amount, breakdown }]])

describe('EvaluationService — alvo em Real', () => {
  let routinesRepo: IRoutinesRepository
  let faresRepo: IFlightFaresRepository
  let alertRepo: ITargetAlertStateRepository
  let notifSvc: INotificationsService
  let fx: IFxRateService
  let svc: EvaluationService

  beforeEach(() => {
    routinesRepo = { findAllActive: vi.fn().mockResolvedValue([]) } as unknown as IRoutinesRepository
    faresRepo = {
      getLatestByRoute: vi.fn().mockResolvedValue([]),
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
        if (currency === 'BRL') return { amount, rate: 1, source: 'native' as const, rateDate: '2026-08-04', stale: false }
        if (currency === 'GBP') return { amount: Math.round(amount * GBP * 100) / 100, rate: GBP, source: 'frankfurter' as const, rateDate: '2026-08-04', stale: false }
        return null
      }),
    } as unknown as IFxRateService

    svc = new EvaluationService(routinesRepo, faresRepo, alertRepo, notifSvc, fx)
  })

  const rodar = async (routine: RoutineRow, fares: LatestFaresByDate[]) => {
    vi.mocked(routinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(faresRepo.getLatestByRoute).mockResolvedValue(fares)
    await svc.runCycle()
  }

  const gravado = () => vi.mocked(alertRepo.recordNotified).mock.calls[0]![2]

  it('tarifa em libra é convertida antes de bater no alvo', async () => {
    // £700 × 6,8 = R$4.760, dentro do alvo de R$5.000. Sem converter, 700 < 5000
    // passaria como pechincha e o alerta sairia errado por quase 7x.
    await rodar(makeRoutine({ target_cash: 5000 }), [makeFare({ currency: 'GBP', fare_cash: 700 })])

    expect(gravado()[0]!.amount).toBe(4760)
  })

  it('tarifa em libra ACIMA do alvo depois de convertida não alerta', async () => {
    // £800 × 6,8 = R$5.440 > R$5.000. No número cru, 800 < 5000 alertaria.
    await rodar(makeRoutine({ target_cash: 5000 }), [makeFare({ currency: 'GBP', fare_cash: 800 })])

    expect(notifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('o mínimo entre companhias é escolhido em Real, não no número cru', async () => {
    // £700 = R$4.760 é mais barato que R$4.900 — mas 700 < 4900 na comparação
    // ingênua, e a rotina escolheria a libra pelo motivo errado.
    await rodar(makeRoutine({ target_cash: 6000, airlines: ['britishairways', 'latam'] }), [
      makeFare({ airline: 'britishairways', currency: 'GBP', fare_cash: 700 }),
      makeFare({ airline: 'latam', currency: 'BRL', fare_cash: 4900 }),
    ])

    expect(gravado()[0]!.amount).toBe(4760)
    expect(gravado()[0]!.airline).toBe('britishairways')
  })

  it('sem cotação, a tarifa sai do ciclo em vez de alertar com número duvidoso', async () => {
    await rodar(makeRoutine({ target_cash: 5000 }), [makeFare({ currency: 'EUR', fare_cash: 100 })])

    expect(alertRepo.recordNotified).not.toHaveBeenCalled()
    expect(notifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('a composição gravada é o que a COMPANHIA cobrou, não o convertido', async () => {
    await rodar(makeRoutine({ target_cash: 5000 }), [makeFare({ currency: 'GBP', fare_cash: 700 })])

    expect(gravado()[0]!.breakdown).toEqual([{ direction: 'outbound', currency: 'GBP', amount: 700 }])
  })
})

describe('EvaluationService — câmbio não é queda de preço', () => {
  let routinesRepo: IRoutinesRepository
  let faresRepo: IFlightFaresRepository
  let alertRepo: ITargetAlertStateRepository
  let notifSvc: INotificationsService
  let fx: IFxRateService
  let svc: EvaluationService

  beforeEach(() => {
    routinesRepo = { findAllActive: vi.fn().mockResolvedValue([]) } as unknown as IRoutinesRepository
    faresRepo = {
      getLatestByRoute: vi.fn().mockResolvedValue([]),
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
        if (currency === 'BRL') return { amount, rate: 1, source: 'native' as const, rateDate: '2026-08-04', stale: false }
        // Hoje a libra vale 6,8; quando o watermark foi gravado valia 6,83.
        if (currency === 'GBP') return { amount: Math.round(amount * GBP * 100) / 100, rate: GBP, source: 'frankfurter' as const, rateDate: '2026-08-04', stale: false }
        return null
      }),
    } as unknown as IFxRateService

    svc = new EvaluationService(routinesRepo, faresRepo, alertRepo, notifSvc, fx)
  })

  const rodar = async (fares: LatestFaresByDate[], wm: Map<string, WatermarkState>) => {
    vi.mocked(routinesRepo.findAllActive).mockResolvedValue([makeRoutine({ target_cash: 6000 })])
    vi.mocked(faresRepo.getLatestByRoute).mockResolvedValue(fares)
    vi.mocked(alertRepo.getWatermarks).mockResolvedValue(wm)
    await svc.runCycle()
  }

  it('câmbio andou mas a companhia não mexeu no preço: NÃO alerta', async () => {
    // O caso que motivou a mudança. A marca foi gravada em R$4.986 (£730 a
    // 6,83); hoje os MESMOS £730 dão R$4.760. Sem a composição isso viraria
    // "novo melhor preço" — e ainda derrubaria a marca, escondendo a queda real
    // que viesse depois.
    await rodar(
      [makeFare({ currency: 'GBP', fare_cash: 730 })],
      watermark(4986, [leg('GBP', 730)]),
    )

    expect(alertRepo.recordNotified).not.toHaveBeenCalled()
    expect(notifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('a companhia baixou o preço de verdade: alerta', async () => {
    // Mesma situação, £700 em vez de £730 — a composição mudou porque o PREÇO
    // mudou, e é exatamente isso que deve alertar.
    await rodar(
      [makeFare({ currency: 'GBP', fare_cash: 700 })],
      watermark(4986, [leg('GBP', 730)]),
    )

    expect(notifSvc.dispatchAlert).toHaveBeenCalledOnce()
  })

  it('melhora abaixo da margem de ruído não alerta', async () => {
    // R$4.960 contra marca de R$5.000 é 0,8%, dentro da margem de 1%.
    await rodar(
      [makeFare({ currency: 'BRL', fare_cash: 4960 })],
      watermark(5000, [leg('BRL', 5000)]),
    )

    expect(notifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('melhora acima da margem alerta', async () => {
    await rodar(
      [makeFare({ currency: 'BRL', fare_cash: 4900 })],
      watermark(5000, [leg('BRL', 5000)]),
    )

    expect(notifSvc.dispatchAlert).toHaveBeenCalledOnce()
  })

  it('linha antiga sem composição mantém o comportamento por valor', async () => {
    // Watermark gravado antes desta mudança tem `breakdown` null. Ele não pode
    // parar de avaliar da noite para o dia.
    await rodar(
      [makeFare({ currency: 'BRL', fare_cash: 4000 })],
      watermark(5000, null),
    )

    expect(notifSvc.dispatchAlert).toHaveBeenCalledOnce()
  })
})
