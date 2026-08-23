import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvaluationService } from './EvaluationService'
import type { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import type { IFlightFaresRepository, LatestFaresByDate, PriceHistory } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import type { ITargetAlertStateRepository, AlertWatermark, WatermarkState } from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
import type { IFxRateService } from '../fx/interfaces/IFxRateService'
import type { INotificationsService } from '../notifications/interfaces/INotificationsService'
import type { RoutineRow } from '../../types/index'

/**
 * Test watermark. The composition is `null` on purpose in the default: that is
 * the state of rows written before the composition existed, and their behaviour
 * must not regress.
 */
function wm(entries: Record<string, number>): Map<string, WatermarkState> {
  return new Map(Object.entries(entries).map(([d, amount]) => [d, { amount, breakdown: null }]))
}

// The incomplete-pair error is what reaches Grafana; the test has to tell
// "discarded and reported" from "tolerated silently". The service logs through
// logger.child(), so the mock has to be of the module, not a spy on the root logger.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
}))
vi.mock('../../utils/logger', () => ({
  logger: { ...logSpy, child: () => logSpy },
}))

// ── helpers ────────────────────────────────────────────────────────────────────

function makeRoutine(overrides: Partial<RoutineRow> = {}): RoutineRow {
  return {
    id:                     'routine-0000-0000-0000-000000000001',
    user_id:                'user-0000-0000-0000-000000000001',
    name:                   'Test Routine',
    airlines:               ['azul'],
    origin:                 'VCP',
    destination:            'LIS',
    outbound_start:         '2026-08-01',
    outbound_end:           '2026-08-31',
    trip_type:              'one_way',
    inbound_start:          null,
    inbound_end:            null,
    passengers:             1,
    currency:               'BRL',
    target_cash:            2000,
    target_pts:             null,
    target_hyb_pts:         null,
    target_hyb_cash:        null,
    margin:                 0.1,
    priority:               'cash',
    notification_modes:     ['target'],
    notification_frequency: 'daily',
    scheduled_time:         null,
    cc_emails:              [],
    is_active:              true,
    created_at:             new Date(),
    updated_at:             new Date(),
    ...overrides,
  }
}

function makeFare(overrides: Partial<LatestFaresByDate> = {}): LatestFaresByDate {
  return {
    airline:        'azul',
    flight_date:    '2026-08-15',
    is_return:      false,
    departure_time: '06:00',
    arrival_time:   '18:00',
    duration_min:   720,
    stops:          1,
    currency:       'BRL',
    fare_cash:      1800,
    fare_pts:       null,
    fare_hyb_pts:   null,
    fare_hyb_cash:  null,
    scraped_at:     new Date(),
    ...overrides,
  }
}

function makeHistory(): PriceHistory {
  return {
    currency:     'BRL',
    avg_cash_30d: 2100,
    min_cash_30d: 1700,
    p20_cash_30d: 1800,
    avg_pts_30d:  null,
    min_pts_30d:  null,
  }
}

// ── mocks ──────────────────────────────────────────────────────────────────────

function makeMocks() {
  const mockRoutinesRepo = {
    findAllActive: vi.fn(),
  } satisfies Partial<IRoutinesRepository> as unknown as IRoutinesRepository

  const mockFlightFaresRepo = {
    getLatestByRoute: vi.fn(),
    getLatestPairs:   vi.fn().mockResolvedValue([]),
    getPriceHistory:  vi.fn().mockResolvedValue(makeHistory()),
  } satisfies Partial<IFlightFaresRepository> as unknown as IFlightFaresRepository

  // By default the "bank" confirms every candidate date as advanced.
  const mockAlertStateRepo = {
    getWatermarks:   vi.fn().mockResolvedValue(new Map<string, WatermarkState>()),
    recordNotified:  vi.fn().mockImplementation(
      async (_r: string, _f: string, entries: AlertWatermark[]) => new Set(entries.map((e) => e.flightDate)),
    ),
    cleanupPastDates: vi.fn().mockResolvedValue(0),
  } satisfies Partial<ITargetAlertStateRepository> as unknown as ITargetAlertStateRepository

  const mockNotifSvc = {
    dispatchAlert: vi.fn().mockResolvedValue(undefined),
  } satisfies Partial<INotificationsService> as unknown as INotificationsService

  // Exchange: by default the fare is already in Real, so conversion is the identity
  // and the existing tests keep talking about the same numbers.
  const mockFx = {
    toBrl: vi.fn(async (amount: number, currency: string) =>
      currency === 'BRL'
        ? { amount, rate: 1, source: 'native' as const, rateDate: '2026-08-04', stale: false }
        : null),
  } satisfies Partial<IFxRateService> as unknown as IFxRateService

  return { mockRoutinesRepo, mockFlightFaresRepo, mockAlertStateRepo, mockNotifSvc, mockFx }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('EvaluationService', () => {
  let mockRoutinesRepo: IRoutinesRepository
  let mockFlightFaresRepo: IFlightFaresRepository
  let mockAlertStateRepo: ITargetAlertStateRepository
  let mockNotifSvc: INotificationsService
  let mockFx: IFxRateService
  let svc: EvaluationService

  beforeEach(() => {
    Object.values(logSpy).forEach((fn) => fn.mockClear())
    const mocks = makeMocks()
    mockRoutinesRepo    = mocks.mockRoutinesRepo
    mockFlightFaresRepo = mocks.mockFlightFaresRepo
    mockAlertStateRepo  = mocks.mockAlertStateRepo
    mockNotifSvc        = mocks.mockNotifSvc
    mockFx              = mocks.mockFx

    svc = new EvaluationService(mockRoutinesRepo, mockFlightFaresRepo, mockAlertStateRepo, mockNotifSvc, mockFx)
  })

  it('sem fares recentes — não chama dispatchAlert', async () => {
    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([makeRoutine()])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([])

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    expect(mockAlertStateRepo.recordNotified).not.toHaveBeenCalled()
  })

  it('rotina sem modo target — não avalia nem chama dispatchAlert', async () => {
    const routine = makeRoutine({ notification_modes: ['scheduled'], target_cash: 2000, margin: 0 })
    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([makeFare({ fare_cash: 1500 })])

    await svc.runCycle()

    expect(mockFlightFaresRepo.getLatestByRoute).not.toHaveBeenCalled()
    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('fare acima do target — não chama dispatchAlert', async () => {
    const routine = makeRoutine({ target_cash: 1000, margin: 0 })
    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([makeFare({ fare_cash: 1500 })])

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    expect(mockAlertStateRepo.recordNotified).not.toHaveBeenCalled()
  })

  it('primeira oferta no alvo (sem watermark) — dispara com a fare e o histórico da data', async () => {
    const routine = makeRoutine({ target_cash: 2000, margin: 0 })
    const fare    = makeFare({ fare_cash: 1900 })
    const history = makeHistory()

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockFlightFaresRepo.getPriceHistory).mockResolvedValue(history)

    await svc.runCycle()

    expect(mockAlertStateRepo.recordNotified).toHaveBeenCalledWith(
      routine.id, 'cash', [expect.objectContaining({ flightDate: '2026-08-15', amount: 1900, airline: 'azul' })],
    )
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine, [fare], history)
  })

  it('mesma tarifa já alertada (watermark == preço) — não vira candidata, não dispara', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const fare    = makeFare({ flight_date: '2026-08-15', fare_cash: 3350 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2026-08-15': 3350 }))

    await svc.runCycle()

    expect(mockAlertStateRepo.recordNotified).not.toHaveBeenCalled()
    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('preço subiu vs. watermark — não dispara', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const fare    = makeFare({ flight_date: '2026-08-15', fare_cash: 3500 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2026-08-15': 3350 }))

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('preço caiu vs. watermark — dispara só essa data', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const fare    = makeFare({ flight_date: '2026-08-15', fare_cash: 3100 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2026-08-15': 3350 }))

    await svc.runCycle()

    expect(mockAlertStateRepo.recordNotified).toHaveBeenCalledWith(
      routine.id, 'cash', [expect.objectContaining({ flightDate: '2026-08-15', amount: 3100, airline: 'azul' })],
    )
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine, [fare], expect.anything())
  })

  it('grid com várias datas no alvo — UM dispatch com todas, ordenadas da mais barata para a mais cara', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const d22 = makeFare({ flight_date: '2027-02-22', fare_cash: 3350 })
    const d25 = makeFare({ flight_date: '2027-02-25', fare_cash: 3100 })
    const d28 = makeFare({ flight_date: '2027-02-28', fare_cash: 3900 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([d22, d25, d28])

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    const [, fares] = vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0]
    expect(fares.map((f) => f.flight_date)).toEqual(['2027-02-25', '2027-02-22', '2027-02-28'])
    // watermarks written for the 3 dates
    const [, , entries] = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0]
    expect(entries.map((e: AlertWatermark) => e.flightDate).sort()).toEqual(['2027-02-22', '2027-02-25', '2027-02-28'])
  })

  it('grid parcial — só a data que melhorou entra no e-mail', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const d22 = makeFare({ flight_date: '2027-02-22', fare_cash: 3350 }) // == watermark → ignorada
    const d25 = makeFare({ flight_date: '2027-02-25', fare_cash: 3100 }) // < watermark → melhora

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([d22, d25])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({
      '2027-02-22': 3350,
      '2027-02-25': 3300,
    }))

    await svc.runCycle()

    const [, , entries] = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0]
    expect(entries).toEqual([expect.objectContaining({ flightDate: '2027-02-25', amount: 3100, airline: 'azul' })])
    const [, fares] = vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0]
    expect(fares.map((f) => f.flight_date)).toEqual(['2027-02-25'])
  })

  it('data nova no alvo com preço >= piso da rotina — grava watermark mas suprime o e-mail', async () => {
    // The bug scenario: the routine already alerted 3100 (date 22). A NEW date (25)
    // enters target at the same or a worse price (3350). Without the record gate
    // that sent one e-mail per cycle, all at the same price, only the date changing.
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const d25 = makeFare({ flight_date: '2027-02-25', fare_cash: 3350 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([d25])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2027-02-22': 3100 }))

    await svc.runCycle()

    // The per-date watermark is written (history/monotonicity intact)...
    expect(mockAlertStateRepo.recordNotified).toHaveBeenCalledWith(
      routine.id, 'cash', [expect.objectContaining({ flightDate: '2027-02-25', amount: 3350, airline: 'azul' })],
    )
    // ...but no e-mail goes out, since 3350 does not beat the 3100 floor.
    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('data nova mais barata que o piso da rotina — dispara (novo recorde)', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const d25 = makeFare({ flight_date: '2027-02-25', fare_cash: 3000 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([d25])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2027-02-22': 3100 }))

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine, [d25], expect.anything())
  })

  it('empate de preço entre datas — histórico e headline são da tarifa coletada mais recentemente (alinha com o card)', async () => {
    // Two dates at the same price; the e-mail renders the one with the most recent
    // scraped_at (the dispatchAlert tiebreak). History has to be computed for THAT
    // same date — otherwise the card shows one date and the "% below average" another.
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const older = makeFare({ flight_date: '2027-02-22', fare_cash: 3100, scraped_at: new Date('2026-06-30T08:00:00Z') })
    const newer = makeFare({ flight_date: '2027-02-25', fare_cash: 3100, scraped_at: new Date('2026-06-30T18:00:00Z') })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([older, newer])

    await svc.runCycle()

    // history fetched for the headline date (the most recent by scraped_at)
    expect(mockFlightFaresRepo.getPriceHistory).toHaveBeenCalledWith('azul', 'VCP', 'LIS', '2027-02-25')
    // and offers[0] (what dispatchAlert renders) is the same fare
    const [, fares] = vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0]
    expect(fares[0].flight_date).toBe('2027-02-25')
  })

  it('corrida — recordNotified devolve vazio (banco cortou) — não dispara', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const fare    = makeFare({ flight_date: '2026-08-15', fare_cash: 3100 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockAlertStateRepo.recordNotified).mockResolvedValue(new Set<string>())

    await svc.runCycle()

    expect(mockAlertStateRepo.recordNotified).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('multi-companhia na mesma data — escolhe a mais barata da data', async () => {
    const routine = makeRoutine({ airlines: ['azul', 'latam'], target_cash: 4000, margin: 0 })
    const azul  = makeFare({ airline: 'azul',  flight_date: '2027-02-22', fare_cash: 3350 })
    const latam = makeFare({ airline: 'latam', flight_date: '2027-02-22', fare_cash: 3100 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockImplementation(
      async (airline: string) => (airline === 'azul' ? [azul] : [latam]),
    )

    await svc.runCycle()

    const [, fares] = vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0]
    expect(fares).toEqual([latam])
    const [, , entries] = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0]
    expect(entries).toEqual([expect.objectContaining({ flightDate: '2027-02-22', amount: 3100, airline: 'latam' })])
  })

  it('escolhe o menor preço NUMÉRICO quando fare_cash vem como string do pg (regressão)', async () => {
    const routine = makeRoutine({ target_cash: 2000, margin: 0 })
    // pg returns NUMERIC as a string; "1076.00" < "652.00" is true lexicographically.
    const expensive = makeFare({ flight_date: '2026-08-11', fare_cash: '1076.00' as unknown as number })
    const cheap     = makeFare({ flight_date: '2026-08-11', fare_cash: '652.00' as unknown as number })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([expensive, cheap])

    await svc.runCycle()

    const [, , entries] = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0]
    expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-11', amount: 652, airline: 'azul' })])
  })

  it('erro em getLatestByRoute — ciclo continua avaliando outras rotinas', async () => {
    const routine1 = makeRoutine({ id: 'routine-1111-0000-0000-000000000001' })
    const routine2 = makeRoutine({ id: 'routine-2222-0000-0000-000000000002' })
    const fare2    = makeFare({ fare_cash: 1500 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine1, routine2])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute)
      .mockRejectedValueOnce(new Error('DB connection failed'))
      .mockResolvedValueOnce([fare2])

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine2, [fare2], expect.anything())
  })

  it('cleanupAlertState delega ao repositório', async () => {
    vi.mocked(mockAlertStateRepo.cleanupPastDates).mockResolvedValue(7)
    const n = await svc.cleanupAlertState()
    expect(n).toBe(7)
    expect(mockAlertStateRepo.cleanupPastDates).toHaveBeenCalledOnce()
  })
  // -- round-trip: collection by PAIR ------------------------------------------

  describe('round_trip', () => {
    const rtRoutine = () => makeRoutine({
      trip_type:     'round_trip',
      inbound_start: '2026-09-01',
      inbound_end:   '2026-09-30',
      target_cash:   3000,
    })

    // An RT search returns BOTH legs of the same pair, sharing the request_id of
    // the run — which is the identity of the pair.
    //
    // NOTE: the return leg has flight_date equal to ITS date (the return date), not
    // the outbound date. The outbound date of the pair comes in pair_outbound_date.
    // The old fixture gave both legs the same flight_date and so never caught the
    // bug that discarded every real pair as incomplete.
    let reqSeq = 0
    const pair = (o: {
      out: string; ret: string; outCash: number; inCash: number;
      bundle?: number | null; outCur?: string; inCur?: string;
    }) => {
      const request_id = `req-pair-${++reqSeq}`
      return [
        { ...makeFare({ flight_date: o.out, is_return: false, fare_cash: o.outCash, currency: o.outCur ?? 'BRL' }),
          return_date: o.ret, origin: 'VCP', destination: 'LIS', bundle_cash: o.bundle ?? null,
          request_id, pair_outbound_date: o.out },
        { ...makeFare({ flight_date: o.ret, is_return: true, fare_cash: o.inCash, currency: o.inCur ?? 'BRL' }),
          return_date: o.ret, origin: 'LIS', destination: 'VCP', bundle_cash: o.bundle ?? null,
          request_id, pair_outbound_date: o.out },
      ]
    }

    const givenPairs = (...rows: unknown[][]) =>
      vi.mocked(mockFlightFaresRepo.getLatestPairs).mockResolvedValue(rows.flat() as never)

    it('par valido - alerta com o total das pernas e leva a volta para o e-mail', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300 }))

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2500, airline: 'azul' })])
      const inboundArg = vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0][3]
      expect(inboundArg?.get('2026-08-15')?.is_return).toBe(true)
    })

    // ── regressão medida em 2026-08-23 ────────────────────────────────────────
    // A rotina "teste 1" mandou nove e-mails com o MESMO preço, um por data
    // coletada. O total do par era somado em ponto flutuante — 1178.54 + 1188.61
    // dá 2367.1499999999996 — e o piso vinha de NUMERIC(12,2), que devolve
    // 2367.15. O `>=` do gate lia a diferença de 4.5e-13 como recorde novo.
    it('data nova com o mesmo total do piso — grava watermark e NÃO manda e-mail', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1178.54, inCash: 1188.61 }))
      vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2026-08-14': 2367.15 }))

      await svc.runCycle()

      // O total soma no centavo, igual ao que a coluna guardaria.
      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2367.15 })])
      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    })

    it('queda menor que a margem de 1% não manda e-mail', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      // 2350,00 contra 2367,15: queda de 0,72%.
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1175.00, inCash: 1175.00 }))
      vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2026-08-15': 2367.15 }))

      await svc.runCycle()

      expect(mockAlertStateRepo.recordNotified).not.toHaveBeenCalled()
      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    })

    it('queda de um centavo não manda e-mail', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1178.53, inCash: 1188.61 }))
      vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2026-08-15': 2367.15 }))

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    })

    it('queda a partir de 1% manda e-mail', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      // 2343,47 contra 2367,15: exatamente 1%.
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1178.54, inCash: 1164.93 }))
      vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(wm({ '2026-08-15': 2367.15 }))

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2343.47 })])
      expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    })

    it('bundle da companhia vence a soma das pernas', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300, bundle: 2100 }))

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2100, airline: 'azul' })])
    })

    it('escolhe o menor total entre pares da mesma data de ida', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(
        pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300 }),
        pair({ out: '2026-08-15', ret: '2026-09-20', outCash: 1200, inCash: 900 }),
      )

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2100, airline: 'azul' })])
    })

    it('moedas diferentes entre as pernas - par descartado', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300, outCur: 'BRL', inCur: 'EUR' }))

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    })

    it('total acima do alvo - nao alerta mesmo com pernas baratas', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([
        makeRoutine({
          trip_type: 'round_trip', inbound_start: '2026-09-01', inbound_end: '2026-09-30',
          target_cash: 2000, margin: 0,
        }),
      ])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1500, inCash: 1500 }))

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    })

    it('par com uma perna so - descartado, nada e alertado', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      const [outboundLeg] = pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300 })
      givenPairs([outboundLeg])

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    })

    // -- 1-to-N: the return belongs to ONE outbound ----------------------------

    // Each return is stamped with the outbound flight that priced it. A pair may
    // bring several outbounds, each with its own list of returns.
    const linkedPair = (o: {
      out: string; ret: string;
      outs: { flight: string; cash: number; inboundUnavailable?: boolean }[];
      ins: { flight: string; cash: number; paired: string }[];
    }) => {
      const request_id = `req-linked-${++reqSeq}`
      return [
        ...o.outs.map((x) => ({
          ...makeFare({ flight_date: o.out, is_return: false, fare_cash: x.cash, currency: 'BRL' }),
          return_date: o.ret, origin: 'VCP', destination: 'LIS',
          flight_number: x.flight, paired_outbound_flight: null, bundle_cash: null,
          inbound_unavailable: x.inboundUnavailable ?? false,
          request_id, pair_outbound_date: o.out,
        })),
        ...o.ins.map((x) => ({
          ...makeFare({ flight_date: o.ret, is_return: true, fare_cash: x.cash, currency: 'BRL' }),
          return_date: o.ret, origin: 'LIS', destination: 'VCP',
          flight_number: x.flight, paired_outbound_flight: x.paired, bundle_cash: null,
          inbound_unavailable: false,
          request_id, pair_outbound_date: o.out,
        })),
      ]
    }

    it('so soma a volta que pertence a ida', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      // The 700 return exists, but only in the context of the 1500 outbound. Crossing
      // it with the 1200 outbound would give 1900 — a pair the airline never offered.
      givenPairs(linkedPair({
        out: '2026-08-15', ret: '2026-09-10',
        outs: [{ flight: 'AD100', cash: 1200 }, { flight: 'AD200', cash: 1500 }],
        ins:  [{ flight: 'AD900', cash: 1300, paired: 'AD100' },
               { flight: 'AD901', cash: 700,  paired: 'AD200' }],
      }))

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2200, airline: 'azul' })])
    })

    it('ida sem volta vinculada nao produz total', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      // AD200 had no returns collected; the only return belongs to AD100.
      givenPairs(linkedPair({
        out: '2026-08-15', ret: '2026-09-10',
        outs: [{ flight: 'AD100', cash: 1400 }, { flight: 'AD200', cash: 1000 }],
        ins:  [{ flight: 'AD900', cash: 1300, paired: 'AD100' }],
      }))

      await svc.runCycle()

      // 1000 + 1300 does not count: the return was not priced in the context of AD200.
      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2700, airline: 'azul' })])
    })

    it('coleta antiga sem vinculo mantem o comportamento por data', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      // Fares written before the stamp: with no link, everything in the pair crosses —
      // otherwise what is already in the bank would stop being evaluated.
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300 }))

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2500, airline: 'azul' })])
    })

    // -- 4.2 undefined return: display, do not alert ---------------------------

    it('volta indefinida por limitacao conhecida - nao alerta e nao reporta erro', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      // No return opened (TudoAzul login). The outbound exists and is cheap, but the
      // outbound price is NOT the trip price.
      givenPairs(linkedPair({
        out: '2026-08-15', ret: '2026-09-10',
        outs: [{ flight: 'AD100', cash: 400, inboundUnavailable: true }],
        ins:  [],
      }))

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
      // A known limitation is not corrupted data: no error in Grafana.
      expect(logSpy.error).not.toHaveBeenCalled()
    })

    it('volta que sumiu sem motivo - segue descartada e reportada', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(linkedPair({
        out: '2026-08-15', ret: '2026-09-10',
        outs: [{ flight: 'AD100', cash: 400 }],
        ins:  [],
      }))

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
      expect(logSpy.error).toHaveBeenCalled()
      const [payload] = logSpy.error.mock.calls[0]
      expect((payload as { err: Error }).err.name).toBe('IncompleteRoundTripError')
    })

    it('ida com volta indefinida nao contamina a ida que tem volta', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      // AD200 is cheaper but ended with no return; the total has to come from AD100.
      givenPairs(linkedPair({
        out: '2026-08-15', ret: '2026-09-10',
        outs: [{ flight: 'AD100', cash: 1200 }, { flight: 'AD200', cash: 400, inboundUnavailable: true }],
        ins:  [{ flight: 'AD900', cash: 1300, paired: 'AD100' }],
      }))

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([expect.objectContaining({ flightDate: '2026-08-15', amount: 2500, airline: 'azul' })])
      expect(logSpy.error).not.toHaveBeenCalled()
    })

    it('nenhum par colhido - segue silencioso', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs()

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
    })

    it('rotina RT NAO le tarifa avulsa - nunca chama getLatestByRoute', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300 }))

      await svc.runCycle()

      expect(mockFlightFaresRepo.getLatestByRoute).not.toHaveBeenCalled()
    })

    it('rotina one-way NAO le tarifa de par - pede explicitamente return_date null', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([makeRoutine()])
      vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([
        makeFare({ flight_date: '2026-08-15', fare_cash: 1800 }),
      ])

      await svc.runCycle()

      expect(mockFlightFaresRepo.getLatestPairs).not.toHaveBeenCalled()
      expect(vi.mocked(mockFlightFaresRepo.getLatestByRoute).mock.calls[0][5]).toBeNull()
    })

    it('one_way nao regride - dispatchAlert segue com a assinatura original', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([makeRoutine()])
      vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([
        makeFare({ flight_date: '2026-08-15', fare_cash: 1800 }),
      ])

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
      expect(vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0]).toHaveLength(3)
    })
  })
})
