import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SchedulerService } from './SchedulerService'
import type { IScrapingJobRepository, ScrapingJobRow } from '../../modules/scraping-jobs/interfaces/IScrapingJobRepository'
import type { IFlightFaresRepository } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import type { IAnalysisRunsRepository } from '../../modules/analysis-runs/interfaces/IAnalysisRunsRepository'
import type { INotificationsService } from '../notifications/interfaces/INotificationsService'
import type { IEvaluationService } from '../evaluation/interfaces/IEvaluationService'
import type { IScraperClient } from '../scraper-client/IScraperClient'
import type { Env } from '../../config/env'

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
    cancel_requested_at: null,
    orphaned_at:         null,
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
    SCRAPE_DISPATCH_BATCH:     5,
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
    FRONTEND_URL:              'http://localhost:3001',
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
    findRunningOrphans:  vi.fn().mockResolvedValue([]),
    retireOrphans:     vi.fn().mockResolvedValue(0),
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
    failStaleRunning:    vi.fn().mockResolvedValue(0),
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
  return { runCycle: vi.fn().mockResolvedValue(undefined) }
}

function makeScraperClientMock(): IScraperClient & { dispatch: ReturnType<typeof vi.fn> } {
  return { dispatch: vi.fn().mockResolvedValue(undefined) }
}

function makeCancelDispatcherMock() {
  return { requestCancel: vi.fn().mockResolvedValue({ delivery: 'no_worker' }) }
}

function makeSvc(
  scrapingJobRepo: IScrapingJobRepository,
  scraperClient = makeScraperClientMock(),
  cancelDispatcher = makeCancelDispatcherMock(),
) {
  const svc = new SchedulerService(
    scrapingJobRepo,
    makeFlightFaresRepoMock(),
    makeNotifMock(),
    makeEvalMock(),
    makeEnv(),
    makeAnalysisRunsRepoMock(),
    scraperClient,
    cancelDispatcher as never,
  )
  return { svc, scraperClient, cancelDispatcher }
}

describe('SchedulerService — dispatch loop', () => {
  it('envia payload correto para o scraper ao despachar um job', async () => {
    const job = makeJob()
    const { svc, scraperClient } = makeSvc(makeScrapingJobRepoMock(job))

    await svc.dispatchOne(job.id)

    expect(scraperClient.dispatch).toHaveBeenCalledOnce()
    const payload = scraperClient.dispatch.mock.calls[0][0]
    expect(payload).toMatchObject({
      routineId:    job.id,
      airline:      'azul',
      origin:       'VCP',
      destination:  'LIS',
      outboundStart: '2026-08-15',
      outboundEnd:   '2026-08-15',
      passengers:    1,
    })
    expect(payload.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('chama upsertFromRoutine com o routineId correto e não chama upsertFromRoutines', async () => {
    const routineId = 'routine-uuid-123'
    const scrapingJobRepo = makeScrapingJobRepoMock(null)
    const { svc } = makeSvc(scrapingJobRepo)

    await svc.dispatchOne(routineId)

    expect(scrapingJobRepo.upsertFromRoutine).toHaveBeenCalledWith(routineId)
    expect(scrapingJobRepo.upsertFromRoutines).not.toHaveBeenCalled()
  })

  it('despacha em lote até o orçamento por companhia, parando quando não há mais job', async () => {
    const job = makeJob()
    const scrapingJobRepo = makeScrapingJobRepoMock()
    vi.mocked(scrapingJobRepo.claimNextJob)
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(null)
    const { svc, scraperClient } = makeSvc(scrapingJobRepo)

    await (svc as never as { dispatchForAirlines(n: number): Promise<void> }).dispatchForAirlines(5)

    expect(scraperClient.dispatch).toHaveBeenCalledTimes(2)
  })

  it('não despacha se não houver job elegível', async () => {
    const { svc, scraperClient } = makeSvc(makeScrapingJobRepoMock(null))

    await svc.dispatchOne('any-id')

    expect(scraperClient.dispatch).not.toHaveBeenCalled()
  })

  it('marca job como failed quando o scraper falha', async () => {
    const job = makeJob()
    const scrapingJobRepo = makeScrapingJobRepoMock(job)
    const scraperClient = makeScraperClientMock()
    scraperClient.dispatch.mockRejectedValueOnce(new Error('scraping.API 503: unavailable'))
    const { svc } = makeSvc(scrapingJobRepo, scraperClient)

    await svc.dispatchOne(job.id)

    expect(scrapingJobRepo.markFailed).toHaveBeenCalledWith(
      job.id,
      expect.stringContaining('503'),
      expect.any(Date),
    )
  })

  it('marca job como dead quando retry_count >= max_retries', async () => {
    const job = makeJob({ retry_count: 2, max_retries: 3 })
    const scrapingJobRepo = makeScrapingJobRepoMock(job)
    const scraperClient = makeScraperClientMock()
    scraperClient.dispatch.mockRejectedValueOnce(new Error('scraping.API 500: error'))
    const { svc } = makeSvc(scrapingJobRepo, scraperClient)

    await svc.dispatchOne(job.id)

    expect(scrapingJobRepo.markDead).toHaveBeenCalledWith(
      job.id,
      expect.stringContaining('500'),
    )
  })
})

describe('SchedulerService — pruneOrphans', () => {
  it('aborta os running órfãos e terminaliza os demais como dead', async () => {
    const scrapingJobRepo = makeScrapingJobRepoMock()
    vi.mocked(scrapingJobRepo.findRunningOrphans).mockResolvedValue([
      makeJob({ id: 'orphan-1', status: 'running', request_id: 'req-1' }),
    ])
    vi.mocked(scrapingJobRepo.retireOrphans).mockResolvedValue(3)
    const { svc, cancelDispatcher } = makeSvc(scrapingJobRepo)

    await svc.pruneOrphans()

    expect(cancelDispatcher.requestCancel).toHaveBeenCalledWith('req-1')
    expect(scrapingJobRepo.retireOrphans).toHaveBeenCalledOnce()
  })

  it('não aborta nada quando não há running órfão, mas ainda terminaliza pendentes', async () => {
    const scrapingJobRepo = makeScrapingJobRepoMock()
    vi.mocked(scrapingJobRepo.retireOrphans).mockResolvedValue(2)
    const { svc, cancelDispatcher } = makeSvc(scrapingJobRepo)

    await svc.pruneOrphans()

    expect(cancelDispatcher.requestCancel).not.toHaveBeenCalled()
    expect(scrapingJobRepo.retireOrphans).toHaveBeenCalledOnce()
  })
})

describe('SchedulerService — circuit breaker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function makeSvcCB() {
    return makeSvc(makeScrapingJobRepoMock()).svc
  }

  it('abre após CIRCUIT_THRESHOLD falhas consecutivas', () => {
    const svc = makeSvcCB()
    for (let i = 0; i < 5; i++) (svc as never as { recordFailure(a: string): void }).recordFailure('azul')
    expect((svc as never as { isCircuitOpen(a: string): boolean }).isCircuitOpen('azul')).toBe(true)
  })

  it('fecha após o cooldown', () => {
    const svc = makeSvcCB() as never as { recordFailure(a: string): void; isCircuitOpen(a: string): boolean }
    for (let i = 0; i < 5; i++) svc.recordFailure('azul')
    expect(svc.isCircuitOpen('azul')).toBe(true)
    vi.advanceTimersByTime(15 * 60 * 1000 + 1)
    expect(svc.isCircuitOpen('azul')).toBe(false)
  })

  it('isola por empresa — falhas em azul não afetam latam', () => {
    const svc = makeSvcCB() as never as { recordFailure(a: string): void; isCircuitOpen(a: string): boolean }
    for (let i = 0; i < 5; i++) svc.recordFailure('azul')
    expect(svc.isCircuitOpen('azul')).toBe(true)
    expect(svc.isCircuitOpen('latam')).toBe(false)
  })

  it('recordSuccess zera contador de falhas e fecha o circuito', () => {
    const svc = makeSvcCB() as never as {
      recordFailure(a: string): void
      recordSuccess(a: string): void
      isCircuitOpen(a: string): boolean
      circuitBreakers: Map<string, { failures: number }>
    }
    for (let i = 0; i < 4; i++) svc.recordFailure('azul')
    svc.recordSuccess('azul')
    expect(svc.isCircuitOpen('azul')).toBe(false)
    expect(svc.circuitBreakers.get('azul')?.failures).toBe(0)
  })
})
