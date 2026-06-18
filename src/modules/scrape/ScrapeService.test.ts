import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScrapeService } from './ScrapeService'
import type { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import type { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import type { IAnalysisRunsRepository } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import type { ScrapeCallback } from './schema'

// ── helpers ────────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<ScrapingJobRow> = {}): ScrapingJobRow {
  return {
    id:                  'job-00000-0000-0000-0000-000000000001',
    airline:             'azul',
    origin:              'VCP',
    destination:         'LIS',
    flight_date:         '2026-08-15',
    status:              'running',
    priority:            80,
    retry_count:         0,
    max_retries:         3,
    next_run_at:         new Date(),
    last_success_at:     null,
    last_failure_at:     null,
    last_error:          null,
    running_since:       new Date(),
    running_timeout_min: 30,
    request_id:          'req-00000-0000-0000-0000-000000000001',
    created_at:          new Date(),
    updated_at:          new Date(),
    ...overrides,
  }
}

function makeCallback(overrides: Partial<ScrapeCallback> = {}): ScrapeCallback {
  return {
    requestId:   'req-00000-0000-0000-0000-000000000001',
    routineId:   undefined,
    airline:     'azul',
    origin:      'VCP',
    destination: 'LIS',
    flights:     [],
    scrapedAt:   new Date().toISOString(),
    error:       undefined,
    ...overrides,
  }
}

function makeFlightOffer() {
  return {
    airline:       'azul',
    flightNumber:  'AD1234',
    date:          '2026-08-15',
    isReturn:      false,
    origin:        'VCP',
    departureTime: '06:00',
    destination:   'LIS',
    arrivalTime:   '18:00',
    durationMin:   720,
    stops:         0,
    currency:      'BRL',
    fareCash:      1800,
    farePts:       null,
    fareHybPts:    null,
    fareHybCash:   null,
  }
}

// ── mocks ──────────────────────────────────────────────────────────────────────

function makeMocks() {
  const mockScrapingJobRepo = {
    findByRequestId:     vi.fn(),
    markFailed:          vi.fn(),
    markDead:            vi.fn(),
    markSuccess:         vi.fn(),
    pauseAirlineForBlock: vi.fn(),
  } satisfies Partial<IScrapingJobRepository> as unknown as IScrapingJobRepository

  const mockFlightFaresRepo = {
    insertMany: vi.fn(),
  } satisfies Partial<IFlightFaresRepository> as unknown as IFlightFaresRepository

  const mockAnalysisRunsRepo = {
    insertRunning: vi.fn(),
    markFinished:  vi.fn(),
  } satisfies Partial<IAnalysisRunsRepository> as unknown as IAnalysisRunsRepository

  return { mockScrapingJobRepo, mockFlightFaresRepo, mockAnalysisRunsRepo }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('ScrapeService.processCallback', () => {
  let mockScrapingJobRepo: IScrapingJobRepository
  let mockFlightFaresRepo: IFlightFaresRepository
  let mockAnalysisRunsRepo: IAnalysisRunsRepository
  let svc: ScrapeService

  beforeEach(() => {
    const mocks = makeMocks()
    mockScrapingJobRepo = mocks.mockScrapingJobRepo
    mockFlightFaresRepo = mocks.mockFlightFaresRepo
    mockAnalysisRunsRepo = mocks.mockAnalysisRunsRepo
    svc = new ScrapeService(mockScrapingJobRepo, mockFlightFaresRepo, mockAnalysisRunsRepo)
  })

  it('requestId desconhecido — retorna sem chamar insertMany', async () => {
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(null)

    await svc.processCallback(makeCallback())

    expect(mockFlightFaresRepo.insertMany).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markFailed).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markDead).not.toHaveBeenCalled()
  })

  it('webhook de erro — retry_count < max_retries — chama markFailed com backoff', async () => {
    const job = makeJob({ retry_count: 1, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockScrapingJobRepo.markFailed).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ error: 'timeout', flights: [] }))

    expect(mockScrapingJobRepo.markFailed).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markFailed).toHaveBeenCalledWith(job.id, 'timeout', expect.any(Date))
    expect(mockScrapingJobRepo.markDead).not.toHaveBeenCalled()
  })

  it('webhook de bloqueio — pausa a airline inteira e não escala para dead', async () => {
    const job = makeJob({ retry_count: 2, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockScrapingJobRepo.pauseAirlineForBlock).mockResolvedValue(7)

    await svc.processCallback(makeCallback({
      error: 'Azul: zero fares and no empty-state marker for VCP→LIS on 2026-08-15 — likely bot/IP block.',
      flights: [],
    }))

    expect(mockScrapingJobRepo.pauseAirlineForBlock).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.pauseAirlineForBlock).toHaveBeenCalledWith('azul', expect.any(Date), expect.stringContaining('bot/IP block'))
    expect(mockScrapingJobRepo.markDead).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markFailed).not.toHaveBeenCalled()
  })

  it('webhook de erro — retry_count >= max_retries — chama markDead', async () => {
    const job = makeJob({ retry_count: 2, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockScrapingJobRepo.markDead).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ error: 'scraper crashed', flights: [] }))

    expect(mockScrapingJobRepo.markDead).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markDead).toHaveBeenCalledWith(job.id, 'scraper crashed')
    expect(mockScrapingJobRepo.markFailed).not.toHaveBeenCalled()
  })

  it('webhook de sucesso — insertMany com fares mapeadas e markSuccess chamado', async () => {
    const job = makeJob({ flight_date: '2026-07-01' })
    const offer1 = makeFlightOffer()
    const offer2 = { ...makeFlightOffer(), flightNumber: 'AD5678', fareCash: 1500 }

    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(2)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ flights: [offer1, offer2] }))

    expect(mockFlightFaresRepo.insertMany).toHaveBeenCalledOnce()
    const [calledJobId, calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledJobId).toBe(job.id)
    expect(calledFares).toHaveLength(2)
    expect(calledFares[0]).toMatchObject({
      flight_number:  'AD1234',
      flight_date:    '2026-08-15',
      is_return:      false,
      origin:         'VCP',
      destination:    'LIS',
      airline:        'azul',
      currency:       'BRL',
      fare_cash:      1800,
    })
    expect(calledFares[1]).toMatchObject({
      flight_number: 'AD5678',
      fare_cash:     1500,
    })

    expect(mockScrapingJobRepo.markSuccess).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markSuccess).toHaveBeenCalledWith(job.id, expect.any(Date))
  })
})
