import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvaluationService } from './EvaluationService'
import type { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import type { IFlightFaresRepository, LatestFaresByDate, PriceHistory } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
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
    return_start:           null,
    return_end:             null,
    passengers:             1,
    currency:               'BRL',
    target_cash:            2000,
    target_pts:             null,
    target_hyb_pts:         null,
    target_hyb_cash:        null,
    margin:                 0.1,
    priority:               'cash',
    notification_modes:     ['email'],
    notification_frequency: 'immediate',
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
    getPriceHistory:  vi.fn(),
  } satisfies Partial<IFlightFaresRepository> as unknown as IFlightFaresRepository

  const mockNotifSvc = {
    hasRecentAlert: vi.fn(),
    dispatchAlert:  vi.fn(),
  } satisfies Partial<INotificationsService> as unknown as INotificationsService

  return { mockRoutinesRepo, mockFlightFaresRepo, mockNotifSvc }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('EvaluationService', () => {
  let mockRoutinesRepo: IRoutinesRepository
  let mockFlightFaresRepo: IFlightFaresRepository
  let mockNotifSvc: INotificationsService
  let svc: EvaluationService

  beforeEach(() => {
    const mocks = makeMocks()
    mockRoutinesRepo  = mocks.mockRoutinesRepo
    mockFlightFaresRepo = mocks.mockFlightFaresRepo
    mockNotifSvc      = mocks.mockNotifSvc

    svc = new EvaluationService(mockRoutinesRepo, mockFlightFaresRepo, mockNotifSvc)
  })

  it('sem fares recentes — não chama dispatchAlert', async () => {
    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([makeRoutine()])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([])

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('rate limited — hasRecentAlert=true — não chama dispatchAlert', async () => {
    const fare = makeFare({ fare_cash: 1500 })
    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([makeRoutine()])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockNotifSvc.hasRecentAlert).mockResolvedValue(true)

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('fare abaixo do target — dispatchAlert chamado com fare e histórico corretos', async () => {
    const routine = makeRoutine({ target_cash: 2000, margin: 0 })
    const fare    = makeFare({ fare_cash: 1900 })
    const history = makeHistory()

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])
    vi.mocked(mockNotifSvc.hasRecentAlert).mockResolvedValue(false)
    vi.mocked(mockFlightFaresRepo.getPriceHistory).mockResolvedValue(history)
    vi.mocked(mockNotifSvc.dispatchAlert).mockResolvedValue(undefined)

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine, fare, null, history)
  })

  it('fare acima do target — não chama dispatchAlert', async () => {
    const routine = makeRoutine({ target_cash: 1000, margin: 0 })
    const fare    = makeFare({ fare_cash: 1500 })

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute).mockResolvedValue([fare])

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).not.toHaveBeenCalled()
  })

  it('erro em getLatestByRoute — ciclo continua avaliando outras rotinas', async () => {
    const routine1 = makeRoutine({ id: 'routine-1111-0000-0000-000000000001' })
    const routine2 = makeRoutine({ id: 'routine-2222-0000-0000-000000000002' })
    const fare2    = makeFare({ fare_cash: 1500 })
    const history  = makeHistory()

    vi.mocked(mockRoutinesRepo.findAllActive).mockResolvedValue([routine1, routine2])
    vi.mocked(mockFlightFaresRepo.getLatestByRoute)
      .mockRejectedValueOnce(new Error('DB connection failed'))
      .mockResolvedValueOnce([fare2])
    vi.mocked(mockNotifSvc.hasRecentAlert).mockResolvedValue(false)
    vi.mocked(mockFlightFaresRepo.getPriceHistory).mockResolvedValue(history)
    vi.mocked(mockNotifSvc.dispatchAlert).mockResolvedValue(undefined)

    await svc.runCycle()

    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledOnce()
    expect(mockNotifSvc.dispatchAlert).toHaveBeenCalledWith(routine2, fare2, null, history)
  })
})
