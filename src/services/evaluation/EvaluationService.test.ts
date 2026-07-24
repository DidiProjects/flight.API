import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvaluationService } from './EvaluationService'
import type { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import type { IFlightFaresRepository, LatestFaresByDate, PriceHistory } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import type { ITargetAlertStateRepository, AlertWatermark } from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
import type { INotificationsService } from '../notifications/interfaces/INotificationsService'
import type { RoutineRow } from '../../types/index'

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

  // Por padrão o "banco" confirma como avançadas todas as datas candidatas.
  const mockAlertStateRepo = {
    getWatermarks:   vi.fn().mockResolvedValue(new Map<string, number>()),
    recordNotified:  vi.fn().mockImplementation(
      async (_r: string, _f: string, entries: AlertWatermark[]) => new Set(entries.map((e) => e.flightDate)),
    ),
    cleanupPastDates: vi.fn().mockResolvedValue(0),
  } satisfies Partial<ITargetAlertStateRepository> as unknown as ITargetAlertStateRepository

  const mockNotifSvc = {
    dispatchAlert: vi.fn().mockResolvedValue(undefined),
  } satisfies Partial<INotificationsService> as unknown as INotificationsService

  return { mockRoutinesRepo, mockFlightFaresRepo, mockAlertStateRepo, mockNotifSvc }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('EvaluationService', () => {
  let mockRoutinesRepo: IRoutinesRepository
  let mockFlightFaresRepo: IFlightFaresRepository
  let mockAlertStateRepo: ITargetAlertStateRepository
  let mockNotifSvc: INotificationsService
  let svc: EvaluationService

  beforeEach(() => {
    const mocks = makeMocks()
    mockRoutinesRepo    = mocks.mockRoutinesRepo
    mockFlightFaresRepo = mocks.mockFlightFaresRepo
    mockAlertStateRepo  = mocks.mockAlertStateRepo
    mockNotifSvc        = mocks.mockNotifSvc

    svc = new EvaluationService(mockRoutinesRepo, mockFlightFaresRepo, mockAlertStateRepo, mockNotifSvc)
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
      routine.id, 'cash', [{ flightDate: '2026-08-15', amount: 1900, airline: 'azul' }],
    )
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine, [fare], history)
  })

  it('mesma tarifa já alertada (watermark == preço) — não vira candidata, não dispara', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const fare    = makeFare({ flight_date: '2026-08-15', fare_cash: 3350 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(new Map([['2026-08-15', 3350]]))

    await svc.runCycle()

    expect(mockAlertStateRepo.recordNotified).not.toHaveBeenCalled()
    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('preço subiu vs. watermark — não dispara', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const fare    = makeFare({ flight_date: '2026-08-15', fare_cash: 3500 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(new Map([['2026-08-15', 3350]]))

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('preço caiu vs. watermark — dispara só essa data', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const fare    = makeFare({ flight_date: '2026-08-15', fare_cash: 3100 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(new Map([['2026-08-15', 3350]]))

    await svc.runCycle()

    expect(mockAlertStateRepo.recordNotified).toHaveBeenCalledWith(
      routine.id, 'cash', [{ flightDate: '2026-08-15', amount: 3100, airline: 'azul' }],
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
    // watermarks gravados para as 3 datas
    const [, , entries] = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0]
    expect(entries.map((e: AlertWatermark) => e.flightDate).sort()).toEqual(['2027-02-22', '2027-02-25', '2027-02-28'])
  })

  it('grid parcial — só a data que melhorou entra no e-mail', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const d22 = makeFare({ flight_date: '2027-02-22', fare_cash: 3350 }) // == watermark → ignorada
    const d25 = makeFare({ flight_date: '2027-02-25', fare_cash: 3100 }) // < watermark → melhora

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([d22, d25])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(new Map([
      ['2027-02-22', 3350],
      ['2027-02-25', 3300],
    ]))

    await svc.runCycle()

    const [, , entries] = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0]
    expect(entries).toEqual([{ flightDate: '2027-02-25', amount: 3100, airline: 'azul' }])
    const [, fares] = vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0]
    expect(fares.map((f) => f.flight_date)).toEqual(['2027-02-25'])
  })

  it('data nova no alvo com preço >= piso da rotina — grava watermark mas suprime o e-mail', async () => {
    // Cenário do bug: a rotina já alertou 3100 (data 22). Uma data NOVA (25)
    // entra no alvo com o mesmo/pior preço (3350). Sem o gate de recorde isso
    // mandava um e-mail por ciclo, todos no mesmo preço, só mudando a data.
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const d25 = makeFare({ flight_date: '2027-02-25', fare_cash: 3350 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([d25])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(new Map([['2027-02-22', 3100]]))

    await svc.runCycle()

    // O watermark por data é gravado (histórico/monotonicidade intactos)...
    expect(mockAlertStateRepo.recordNotified).toHaveBeenCalledWith(
      routine.id, 'cash', [{ flightDate: '2027-02-25', amount: 3350, airline: 'azul' }],
    )
    // ...mas nenhum e-mail é enviado, pois 3350 não bate o piso 3100.
    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('data nova mais barata que o piso da rotina — dispara (novo recorde)', async () => {
    const routine = makeRoutine({ target_cash: 4000, margin: 0 })
    const d25 = makeFare({ flight_date: '2027-02-25', fare_cash: 3000 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([d25])
    vi.mocked(mockAlertStateRepo.getWatermarks).mockResolvedValue(new Map([['2027-02-22', 3100]]))

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine, [d25], expect.anything())
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
    expect(entries).toEqual([{ flightDate: '2027-02-22', amount: 3100, airline: 'latam' }])
  })

  it('escolhe o menor preço NUMÉRICO quando fare_cash vem como string do pg (regressão)', async () => {
    const routine = makeRoutine({ target_cash: 2000, margin: 0 })
    // pg devolve NUMERIC como string; "1076.00" < "652.00" é true lexicograficamente.
    const expensive = makeFare({ flight_date: '2026-08-11', fare_cash: '1076.00' as unknown as number })
    const cheap     = makeFare({ flight_date: '2026-08-11', fare_cash: '652.00' as unknown as number })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([expensive, cheap])

    await svc.runCycle()

    const [, , entries] = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0]
    expect(entries).toEqual([{ flightDate: '2026-08-11', amount: 652, airline: 'azul' }])
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
  // -- round-trip: coleta por PAR ---------------------------------------------

  describe('round_trip', () => {
    const rtRoutine = () => makeRoutine({
      trip_type:     'round_trip',
      inbound_start: '2026-09-01',
      inbound_end:   '2026-09-30',
      target_cash:   3000,
    })

    // Uma busca RT devolve as DUAS pernas do mesmo par: mesma (flight_date,
    // return_date), a volta com a rota invertida e is_return=true.
    const pair = (o: {
      out: string; ret: string; outCash: number; inCash: number;
      bundle?: number | null; outCur?: string; inCur?: string;
    }) => [
      { ...makeFare({ flight_date: o.out, is_return: false, fare_cash: o.outCash, currency: o.outCur ?? 'BRL' }),
        return_date: o.ret, origin: 'VCP', destination: 'LIS', bundle_cash: o.bundle ?? null },
      { ...makeFare({ flight_date: o.out, is_return: true, fare_cash: o.inCash, currency: o.inCur ?? 'BRL' }),
        return_date: o.ret, origin: 'LIS', destination: 'VCP', bundle_cash: o.bundle ?? null },
    ]

    const givenPairs = (...rows: unknown[][]) =>
      vi.mocked(mockFlightFaresRepo.getLatestPairs).mockResolvedValue(rows.flat() as never)

    it('par valido - alerta com o total das pernas e leva a volta para o e-mail', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300 }))

      await svc.runCycle()

      expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([{ flightDate: '2026-08-15', amount: 2500, airline: 'azul' }])
      const inboundArg = vi.mocked(mockNotifSvc.dispatchAlert).mock.calls[0][3]
      expect(inboundArg?.get('2026-08-15')?.is_return).toBe(true)
    })

    it('bundle da companhia vence a soma das pernas', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300, bundle: 2100 }))

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([{ flightDate: '2026-08-15', amount: 2100, airline: 'azul' }])
    })

    it('escolhe o menor total entre pares da mesma data de ida', async () => {
      vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([rtRoutine()])
      givenPairs(
        pair({ out: '2026-08-15', ret: '2026-09-10', outCash: 1200, inCash: 1300 }),
        pair({ out: '2026-08-15', ret: '2026-09-20', outCash: 1200, inCash: 900 }),
      )

      await svc.runCycle()

      const entries = vi.mocked(mockAlertStateRepo.recordNotified).mock.calls[0][2]
      expect(entries).toEqual([{ flightDate: '2026-08-15', amount: 2100, airline: 'azul' }])
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
