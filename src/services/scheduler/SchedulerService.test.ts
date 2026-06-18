import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SchedulerService } from './SchedulerService'
import type { IScrapingJobRepository, ScrapingJobRow } from '../../modules/scraping-jobs/interfaces/IScrapingJobRepository'
import type { IFlightFaresRepository } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import type { IAnalysisRunsRepository } from '../../modules/analysis-runs/interfaces/IAnalysisRunsRepository'
import type { INotificationsService } from '../notifications/interfaces/INotificationsService'
import type { IEvaluationService } from '../evaluation/interfaces/IEvaluationService'
import type { Env } from '../../config/env'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<ScrapingJobRow> = {}): ScrapingJobRow {
  return {
    id:                  'aaaaaaaa-0000-0000-0000-000000000001',
    airline:             'azul',
    origin:              'VCP',
    destination:         'LIS',
    flight_date:         '2026-08-15',
    status:              'pending',
    priority:            80,
    retry_count:         0,
    max_retries:         3,
    next_run_at:         new Date(),
    last_success_at:     null,
    last_failure_at:     null,
    last_error:          null,
    running_since:       null,
    running_timeout_min: 30,
    request_id:          null,
    created_at:          new Date(),
    updated_at:          new Date(),
    ...overrides,
  }
}

function makeEnv(): Env {
  return {
    NODE_ENV:                  'test',
    PORT:                      3011,
    HOST:                      '0.0.0.0',
    POSTGRES_HOST:             'localhost',
    POSTGRES_PORT:             5432,
    POSTGRES_USER:             'admin',
    POSTGRES_PASSWORD:         'admin',
    POSTGRES_DB:               'test',
    JWT_SECRET:                'x'.repeat(32),
    JWT_EXPIRES_IN:            '15m',
    JWT_REFRESH_EXPIRES_IN:    '30d',
    SCRAPE_INTERVAL_MS:        3_600_000,
    SCRAPE_INTERVAL_JITTER_MS: 300_000,
    EVALUATION_INTERVAL_MS:    300_000,
    SCRAPING_API_URL:          'http://scraping-api',
    SCRAPING_API_KEY:          'test-key',
    FLIGHT_API_KEY:            'flight-key',
    SMTP_HOST:                 'smtp.test',
    SMTP_PORT:                 587,
    SMTP_USER:                 'test@test.com',
    SMTP_PASSWORD:             'pass',
    SMTP_FROM:                 'test@test.com',
    ADMIN_EMAIL:               'admin@test.com',
    ADMIN_PASSWORD_INITIAL:    'changeme123',
    API_BASE_URL:              'http://localhost:3011/flight',
    FRONTEND_URL:              'http://localhost:3000',
    LOG_LEVEL:                 'info',
  } as Env
}

function makeScrapingJobRepoMock(job: ScrapingJobRow | null = null): IScrapingJobRepository {
  return {
    upsertFromRoutines:  vi.fn().mockResolvedValue(0),
    upsertFromRoutine:   vi.fn().mockResolvedValue(undefined),
    expireOldJobs:       vi.fn().mockResolvedValue(0),
    updatePriorities:    vi.fn().mockResolvedValue(undefined),
    claimNextJob:        vi.fn().mockResolvedValue(job),
    markRunning:         vi.fn().mockResolvedValue(undefined),
    markSuccess:         vi.fn().mockResolvedValue(undefined),
    markFailed:          vi.fn().mockResolvedValue(undefined),
    markDead:            vi.fn().mockResolvedValue(undefined),
    recoverStuckJobs:    vi.fn().mockResolvedValue(0),
    findByRequestId:     vi.fn().mockResolvedValue(null),
    getActiveAirlines:   vi.fn().mockResolvedValue(['azul']),
    cleanupDeadJobs:     vi.fn().mockResolvedValue(0),
  } as unknown as IScrapingJobRepository
}

function makeFlightFaresRepoMock(): IFlightFaresRepository {
  return {
    insertMany:            vi.fn().mockResolvedValue(0),
    getLatestByRoute:      vi.fn().mockResolvedValue([]),
    getPriceHistory:       vi.fn().mockResolvedValue({}),
    aggregateToDailyBucket: vi.fn().mockResolvedValue(0),
    cleanupOlderThan:      vi.fn().mockResolvedValue(0),
  } as unknown as IFlightFaresRepository
}

function makeAnalysisRunsRepoMock(): IAnalysisRunsRepository {
  return {
    insertRunning:       vi.fn().mockResolvedValue(undefined),
    markFinished:        vi.fn().mockResolvedValue(undefined),
    listByRoutineMatch:  vi.fn().mockResolvedValue([]),
    cleanupOlderThan:    vi.fn().mockResolvedValue(0),
  } as unknown as IAnalysisRunsRepository
}

function makeNotifMock(): INotificationsService {
  return {
    evaluate:        vi.fn().mockResolvedValue(undefined),
    sendScheduled:   vi.fn().mockResolvedValue(undefined),
    hasRecentAlert:  vi.fn().mockResolvedValue(false),
    dispatchAlert:   vi.fn().mockResolvedValue(undefined),
  } as unknown as INotificationsService
}

function makeEvalMock(): IEvaluationService {
  return {
    runCycle: vi.fn().mockResolvedValue(undefined),
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SchedulerService — dispatch loop', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('envia payload correto para scraping.API ao despachar um job', async () => {
    const job = makeJob()
    const scrapingJobRepo = makeScrapingJobRepoMock(job)
    const svc = new SchedulerService(
      scrapingJobRepo,
      makeFlightFaresRepoMock(),
      makeNotifMock(),
      makeEvalMock(),
      makeEnv(),
      makeAnalysisRunsRepoMock(),
    )

    await svc.dispatchOne(job.id)

    expect(fetchMock).toHaveBeenCalledOnce()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      routineId:    job.id,
      airline:      'azul',
      origin:       'VCP',
      destination:  'LIS',
      outboundStart: '2026-08-15',
      outboundEnd:   '2026-08-15',
      passengers:    1,
    })
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('envia X-API-Key no header', async () => {
    const job = makeJob()
    const svc = new SchedulerService(
      makeScrapingJobRepoMock(job),
      makeFlightFaresRepoMock(),
      makeNotifMock(),
      makeEvalMock(),
      makeEnv(),
      makeAnalysisRunsRepoMock(),
    )

    await svc.dispatchOne(job.id)

    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-API-Key']).toBe('test-key')
  })

  it('chama upsertFromRoutine com o routineId correto e não chama upsertFromRoutines', async () => {
    const routineId = 'routine-uuid-123'
    const scrapingJobRepo = makeScrapingJobRepoMock(null)
    const svc = new SchedulerService(
      scrapingJobRepo,
      makeFlightFaresRepoMock(),
      makeNotifMock(),
      makeEvalMock(),
      makeEnv(),
      makeAnalysisRunsRepoMock(),
    )

    await svc.dispatchOne(routineId)

    expect(scrapingJobRepo.upsertFromRoutine).toHaveBeenCalledWith(routineId)
    expect(scrapingJobRepo.upsertFromRoutines).not.toHaveBeenCalled()
  })

  it('não faz chamada HTTP se não houver job elegível', async () => {
    const svc = new SchedulerService(
      makeScrapingJobRepoMock(null),
      makeFlightFaresRepoMock(),
      makeNotifMock(),
      makeEvalMock(),
      makeEnv(),
      makeAnalysisRunsRepoMock(),
    )

    await svc.dispatchOne('any-id')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marca job como failed quando scraping.API retorna erro HTTP', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
    const job = makeJob()
    const scrapingJobRepo = makeScrapingJobRepoMock(job)
    const svc = new SchedulerService(
      scrapingJobRepo,
      makeFlightFaresRepoMock(),
      makeNotifMock(),
      makeEvalMock(),
      makeEnv(),
      makeAnalysisRunsRepoMock(),
    )

    await svc.dispatchOne(job.id)

    expect(scrapingJobRepo.markFailed).toHaveBeenCalledWith(
      job.id,
      expect.stringContaining('503'),
      expect.any(Date),
    )
  })

  it('marca job como dead quando retry_count >= max_retries', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' })
    const job = makeJob({ retry_count: 2, max_retries: 3 })
    const scrapingJobRepo = makeScrapingJobRepoMock(job)
    const svc = new SchedulerService(
      scrapingJobRepo,
      makeFlightFaresRepoMock(),
      makeNotifMock(),
      makeEvalMock(),
      makeEnv(),
      makeAnalysisRunsRepoMock(),
    )

    await svc.dispatchOne(job.id)

    expect(scrapingJobRepo.markDead).toHaveBeenCalledWith(
      job.id,
      expect.stringContaining('500'),
    )
  })
})

// ── circuit breaker ───────────────────────────────────────────────────────────

describe('SchedulerService — circuit breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function makeSvc() {
    return new SchedulerService(
      makeScrapingJobRepoMock(),
      makeFlightFaresRepoMock(),
      makeNotifMock(),
      makeEvalMock(),
      makeEnv(),
      makeAnalysisRunsRepoMock(),
    )
  }

  it('abre após CIRCUIT_THRESHOLD falhas consecutivas', () => {
    const svc = makeSvc()
    for (let i = 0; i < 5; i++) {
      ;(svc as any).recordFailure('azul')
    }
    expect((svc as any).isCircuitOpen('azul')).toBe(true)
  })

  it('fecha após o cooldown', () => {
    const svc = makeSvc()
    for (let i = 0; i < 5; i++) {
      ;(svc as any).recordFailure('azul')
    }
    expect((svc as any).isCircuitOpen('azul')).toBe(true)

    vi.advanceTimersByTime(15 * 60 * 1000 + 1)

    expect((svc as any).isCircuitOpen('azul')).toBe(false)
  })

  it('isola por empresa — falhas em azul não afetam latam', () => {
    const svc = makeSvc()
    for (let i = 0; i < 5; i++) {
      ;(svc as any).recordFailure('azul')
    }
    expect((svc as any).isCircuitOpen('azul')).toBe(true)
    expect((svc as any).isCircuitOpen('latam')).toBe(false)
  })

  it('recordSuccess zera contador de falhas e fecha o circuito', () => {
    const svc = makeSvc()
    for (let i = 0; i < 4; i++) {
      ;(svc as any).recordFailure('azul')
    }
    ;(svc as any).recordSuccess('azul')

    expect((svc as any).isCircuitOpen('azul')).toBe(false)
    const state = (svc as any).circuitBreakers.get('azul')
    expect(state?.failures).toBe(0)
  })
})
