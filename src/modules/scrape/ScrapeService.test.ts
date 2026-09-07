import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScrapeService } from './ScrapeService'
import type { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import type { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import type { IAnalysisRunsRepository } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import type { IFxRateService } from '../../services/fx/interfaces/IFxRateService'
import type { IFareHistoryRepository } from '../fare-history/interfaces/IFareHistoryRepository'
import { batchCallbackSchema, type BatchCallback, type ScrapeCallback } from './schema'

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
    cancel_requested_at: null,
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
    findById:            vi.fn(),
    markFailed:          vi.fn(),
    markDead:            vi.fn(),
    markSuccess:         vi.fn(),
    markSiteError:       vi.fn(),
    pauseAirlineForBlock: vi.fn(),
    holdForBatch:        vi.fn(),
    settleBatchItem:     vi.fn(),
  } satisfies Partial<IScrapingJobRepository> as unknown as IScrapingJobRepository

  const mockFlightFaresRepo = {
    insertMany: vi.fn(),
  } satisfies Partial<IFlightFaresRepository> as unknown as IFlightFaresRepository

  const mockAnalysisRunsRepo = {
    insertRunning: vi.fn(),
    markFinished:  vi.fn(),
  } satisfies Partial<IAnalysisRunsRepository> as unknown as IAnalysisRunsRepository

  // Fixed, deterministic exchange: BRL does not convert, GBP is worth 7. The tests
  // in this file check the fare mapping, not the quote — but conversion now happens
  // at ingestion (017) and needs a provider.
  const mockFx = {
    toBrl: vi.fn(async (amount: number, currency: string) =>
      currency === 'BRL'
        ? { amount, rate: 1, source: 'native' as const, rateDate: '2026-08-20', stale: false }
        : { amount: amount * 7, rate: 7, source: 'frankfurter' as const, rateDate: '2026-08-20', stale: false },
    ),
    convert: vi.fn(),
  } satisfies Partial<IFxRateService> as unknown as IFxRateService

  const mockFareHistoryRepo = {
    recordRun:            vi.fn().mockResolvedValue(0),
    cleanupNotSeenSince:  vi.fn().mockResolvedValue(0),
  } satisfies IFareHistoryRepository as IFareHistoryRepository

  // Sem lote vivo por padrão: os callbacks destes testes são de item solto, que é o
  // regime de `batch_size = 1`. Os testes de lote montam o seu próprio.
  const mockBatchRepo = {
    findById:            vi.fn().mockResolvedValue(null),
    closeLiveByAirline:  vi.fn().mockResolvedValue([]),
    registerReceived:    vi.fn().mockResolvedValue(null),
    markRunning:         vi.fn().mockResolvedValue(undefined),
    markClosing:         vi.fn().mockResolvedValue(undefined),
    close:               vi.fn().mockResolvedValue(null),
    listItems:           vi.fn().mockResolvedValue([]),
  }

  return { mockScrapingJobRepo, mockFlightFaresRepo, mockAnalysisRunsRepo, mockFx, mockFareHistoryRepo, mockBatchRepo }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('ScrapeService.processCallback', () => {
  let mockScrapingJobRepo: IScrapingJobRepository
  let mockFlightFaresRepo: IFlightFaresRepository
  let mockAnalysisRunsRepo: IAnalysisRunsRepository
  let mockFareHistoryRepo: IFareHistoryRepository
  let mockBatchRepo: ReturnType<typeof makeMocks>['mockBatchRepo']
  let svc: ScrapeService

  beforeEach(() => {
    const mocks = makeMocks()
    mockScrapingJobRepo = mocks.mockScrapingJobRepo
    mockFlightFaresRepo = mocks.mockFlightFaresRepo
    mockAnalysisRunsRepo = mocks.mockAnalysisRunsRepo
    mockFareHistoryRepo = mocks.mockFareHistoryRepo
    mockBatchRepo = mocks.mockBatchRepo
    svc = new ScrapeService(mockScrapingJobRepo, mockFlightFaresRepo, mockAnalysisRunsRepo, mocks.mockFx, mockFareHistoryRepo, mockBatchRepo as never)
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

  it('o estado terminal manda, mesmo quando o texto do erro fala em bloqueio', async () => {
    // The case that drove the change: LATAM was paused for an hour, three times on
    // 2026-08-20, because the scraper wrote "likely bot/IP block" into the text — and
    // this service read the text. The page was the error page of the airline itself,
    // and the classifier, with the DOM in hand, says SITE_ERROR.
    const job = makeJob({ retry_count: 0, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      error: 'LATAM: zero cards and no empty-state marker — likely bot/IP block.',
      flights: [],
      outcome: { state: 'SITE_ERROR', reason: 'a companhia redirecionou para a própria página de erro' },
    }))

    expect(mockScrapingJobRepo.pauseAirlineForBlock).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markSiteError).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markFailed).not.toHaveBeenCalled()
  })

  it('falha do site não escala para dead, nem na última tentativa', async () => {
    // The airline search failing to respond is not the job's fault; killing it would
    // drop the route from collection until the next derivation.
    const job = makeJob({ retry_count: 2, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      error: 'LATAM: search failed on the airline side (site error page) — retry later.',
      flights: [],
      outcome: { state: 'SITE_ERROR', reason: 'falha declarada pelo site' },
    }))

    expect(mockScrapingJobRepo.markDead).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markSiteError).toHaveBeenCalledOnce()
  })

  it('bloqueio declarado pelo classificador pausa a companhia', async () => {
    const job = makeJob({ retry_count: 0, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockScrapingJobRepo.pauseAirlineForBlock).mockResolvedValue(3)

    await svc.processCallback(makeCallback({
      error: 'Azul: sem ofertas',
      flights: [],
      outcome: { state: 'BLOCKED', reason: 'marcador de anti-bot na página', evidence: 'comportamento incomum vindo do seu IP' },
    }))

    expect(mockScrapingJobRepo.pauseAirlineForBlock).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markSiteError).not.toHaveBeenCalled()
  })

  it('layout mudado é falha do job: backoff normal, sem pausar a companhia', async () => {
    // The state that calls for a code change. Pausing the airline here would hide the
    // problem for an hour and fix nothing.
    const job = makeJob({ retry_count: 0, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      error: 'LATAM: no cards and no empty-state marker — page ended in an unknown state.',
      flights: [],
      outcome: { state: 'LAYOUT_CHANGED', reason: 'sem marcador nenhum' },
    }))

    expect(mockScrapingJobRepo.pauseAirlineForBlock).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markSiteError).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markFailed).toHaveBeenCalledOnce()
  })

  it('bloqueio SEM texto de erro pausa a companhia e não conta como coleta', async () => {
    // The real shape of a block: it paints a screen, it does not raise. The scraper
    // reports it in `outcome` and sends no `error` — and while the gate asked only for
    // `error`, this callback reached markSuccess with zero fares.
    const job = makeJob({ retry_count: 0, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockScrapingJobRepo.pauseAirlineForBlock).mockResolvedValue(2)

    await svc.processCallback(makeCallback({
      flights: [],
      outcome: { state: 'BLOCKED', reason: 'resposta da borda do CDN, não da origem' },
    }))

    expect(mockScrapingJobRepo.pauseAirlineForBlock).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markSuccess).not.toHaveBeenCalled()
    expect(mockAnalysisRunsRepo.markFinished).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'blocked' }),
    )
  })

  it('o motivo do outcome vira a mensagem quando não há texto de erro', async () => {
    const job = makeJob({ retry_count: 0, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      flights: [],
      outcome: { state: 'LAYOUT_CHANGED', reason: 'sem marcador nenhum' },
    }))

    expect(mockScrapingJobRepo.markFailed).toHaveBeenCalledWith(
      job.id,
      'LAYOUT_CHANGED: sem marcador nenhum',
      expect.any(Date),
    )
  })

  it('EMPTY continua sendo sucesso: não há voo, e retentar queimaria a data', async () => {
    // Deliberate. A date the airline says has no flight would walk the backoff to `dead`
    // and be dropped from the current price. The false EMPTY is fixed in the scraper,
    // which now classifies the anti-bot screen as BLOCKED.
    const job = makeJob({ retry_count: 0, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(0)

    await svc.processCallback(makeCallback({
      flights: [],
      outcome: { state: 'EMPTY', reason: 'a companhia declarou que não há voos' },
    }))

    expect(mockScrapingJobRepo.markSuccess).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markFailed).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.pauseAirlineForBlock).not.toHaveBeenCalled()
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

  /**
   * The failures of 2026-08-27: the worker had no WS, every job lost its lease and was
   * re-dispatched, and EVERY callback came back orphaned. The block cooldown lives on
   * this path, so Azul was blocked, released and asked again, cycle after cycle.
   */
  it('callback órfão de bloqueio — pausa a companhia mesmo sem job identificado', async () => {
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(null)
    vi.mocked(mockScrapingJobRepo.findById).mockResolvedValue(null)
    vi.mocked(mockScrapingJobRepo.pauseAirlineForBlock).mockResolvedValue(4)

    await svc.processCallback(makeCallback({
      airline: 'azul',
      error:   'Access Denied',
      flights: [],
      outcome: { state: 'BLOCKED', reason: 'marcador de anti-bot na página' },
    }))

    expect(mockScrapingJobRepo.pauseAirlineForBlock).toHaveBeenCalledWith('azul', expect.any(Date), 'Access Denied')
    expect(mockAnalysisRunsRepo.markFinished).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ status: 'blocked' }),
    )
  })

  it('callback órfão de erro — o job reidratado leva o backoff, não fica intocado', async () => {
    const job = makeJob({ status: 'pending', request_id: null, retry_count: 1, max_retries: 3 })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(null)
    vi.mocked(mockScrapingJobRepo.findById).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      routineId: job.id,
      error:     'timeout',
      flights:   [],
    }))

    expect(mockScrapingJobRepo.markFailed).toHaveBeenCalledWith(job.id, 'timeout', expect.any(Date))
  })

  it('callback órfão de erro com job já re-despachado — não sobrescreve a corrida nova', async () => {
    const job = makeJob({ status: 'running', request_id: 'req-novo-despacho' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(null)
    vi.mocked(mockScrapingJobRepo.findById).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      routineId: job.id,
      requestId: 'req-00000-0000-0000-0000-0000000000aa',
      error:     'timeout',
      flights:   [],
    }))

    expect(mockScrapingJobRepo.markFailed).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markDead).not.toHaveBeenCalled()
    expect(mockAnalysisRunsRepo.markFinished).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ status: 'failed' }),
    )
  })

  it('callback órfão de sucesso — reidrata job por id, salva fares e marca sucesso', async () => {
    const job = makeJob({ status: 'pending', request_id: null, flight_date: '2026-07-01' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(null)
    vi.mocked(mockScrapingJobRepo.findById).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)

    await svc.processCallback(makeCallback({
      routineId: job.id,
      requestId: 'req-00000-0000-0000-0000-0000000000ff',
      flights:   [makeFlightOffer()],
    }))

    expect(mockScrapingJobRepo.findById).toHaveBeenCalledWith(job.id)
    expect(mockFlightFaresRepo.insertMany).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markSuccess).toHaveBeenCalledWith(job.id, expect.any(Date))
  })

  it('callback órfão de sucesso com job já re-despachado — salva fares mas NÃO sobrescreve o job', async () => {
    const job = makeJob({ status: 'running', request_id: 'req-novo-despacho' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(null)
    vi.mocked(mockScrapingJobRepo.findById).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)

    await svc.processCallback(makeCallback({
      routineId: job.id,
      requestId: 'req-antigo-atrasado',
      flights:   [makeFlightOffer()],
    }))

    expect(mockFlightFaresRepo.insertMany).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markSuccess).not.toHaveBeenCalled()
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
    const [calledJobId, calledRequestId, calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledJobId).toBe(job.id)
    // the run request_id is passed through to become the snapshot discriminator in
    // flight_fares (without it, re-collections of the same route would freeze the price).
    expect(calledRequestId).toBe('req-00000-0000-0000-0000-000000000001')
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

  it('o histórico curado é alimentado com o request_id da coleta', async () => {
    const job = makeJob({ flight_date: '2026-07-01' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ flights: [makeFlightOffer()] }))

    expect(mockFareHistoryRepo.recordRun).toHaveBeenCalledWith('req-00000-0000-0000-0000-000000000001')
  })

  // The history is fed inside a try/catch, so a broken repository would leave the
  // suite green while nothing was recorded. This pins the collection as the part
  // that must survive, and the history as the part allowed to fail.
  it('histórico que falha não derruba a coleta nem o reagendamento', async () => {
    const job = makeJob({ flight_date: '2026-07-01' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)
    vi.mocked(mockFareHistoryRepo.recordRun).mockRejectedValue(new Error('boom'))

    await expect(svc.processCallback(makeCallback({ flights: [makeFlightOffer()] }))).resolves.toBeUndefined()

    expect(mockFlightFaresRepo.insertMany).toHaveBeenCalledOnce()
    expect(mockScrapingJobRepo.markSuccess).toHaveBeenCalledOnce()
  })

  it('volta carrega o vinculo com a ida que a precificou', async () => {
    const job = makeJob({ flight_date: '2026-08-15', return_date: '2026-09-10' })
    const outbound = makeFlightOffer()
    const inbound = {
      ...makeFlightOffer(),
      flightNumber: 'AD9999', isReturn: true, origin: 'LIS', destination: 'VCP',
      pairedOutboundFlight: 'AD1234',
    }

    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(2)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ flights: [outbound, inbound] }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares[0]).toMatchObject({ is_return: false, paired_outbound_flight: null })
    expect(calledFares[1]).toMatchObject({ is_return: true, paired_outbound_flight: 'AD1234' })
  })

  it('ida que venha carimbada por engano nao guarda o vinculo', async () => {
    const job = makeJob({ flight_date: '2026-08-15', return_date: '2026-09-10' })
    // The link exists ONLY on the return; storing it on the outbound would corrupt grouping.
    const outbound = { ...makeFlightOffer(), isReturn: false, pairedOutboundFlight: 'AD1234' }

    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ flights: [outbound] }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares[0]).toMatchObject({ paired_outbound_flight: null })
  })

  it('volta indefinida e marcada na ida, nunca na volta', async () => {
    const job = makeJob({ flight_date: '2026-08-15', return_date: '2026-09-10' })
    // The limitation belongs to the OUTBOUND: ITS returns did not open.
    const outbound = { ...makeFlightOffer(), inboundUnavailable: true }
    const inbound = {
      ...makeFlightOffer(),
      flightNumber: 'AD9999', isReturn: true, origin: 'LIS', destination: 'VCP',
      inboundUnavailable: true,
    }

    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(2)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ flights: [outbound, inbound] }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares[0]).toMatchObject({ is_return: false, inbound_unavailable: true })
    expect(calledFares[1]).toMatchObject({ is_return: true, inbound_unavailable: false })
  })

  it('callback sem o campo novo - ida nao fica marcada', async () => {
    const job = makeJob({ flight_date: '2026-08-15' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    await svc.processCallback(makeCallback({ flights: [makeFlightOffer()] }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares[0]).toMatchObject({ inbound_unavailable: false })
  })

  // ── currency required ────────────────────────────────────────────────────────

  it('oferta sem moeda é descartada, e as boas da mesma coleta são gravadas', async () => {
    // `flight_fares.currency` is NOT NULL and the insert is ONE multi-row command:
    // without this filter a single bad offer would abort the batch and the whole
    // collection would be lost over one row.
    const job = makeJob({ flight_date: '2026-08-15' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    const boa = makeFlightOffer()
    const semMoeda = { ...makeFlightOffer(), flightNumber: 'AD9999', currency: undefined }

    await svc.processCallback(makeCallback({ flights: [boa, semMoeda] as never }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares).toHaveLength(1)
    expect(calledFares[0]).toMatchObject({ flight_number: 'AD1234', currency: 'BRL' })
  })

  it('código de moeda malformado também é descartado', async () => {
    const job = makeJob({ flight_date: '2026-08-15' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(0)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    const ruim = { ...makeFlightOffer(), currency: 'REAIS' }

    await svc.processCallback(makeCallback({ flights: [ruim] as never }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares).toEqual([])
  })

  // ── unreadable flight number ─────────────────────────────────────────────────

  it('número de voo vazio vira NULL, e duas leituras falhas não colidem na dedup', async () => {
    // The LATAM scraper uses '' when the modal does not open. The dedup unique index
    // only ignores NULL, so two rows with '' collided on the key and the second was
    // discarded — losing a real fare for not knowing its number.
    const job = makeJob({ flight_date: '2026-08-15' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(2)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    const semNumero1 = { ...makeFlightOffer(), flightNumber: '', fareCash: 363.65 }
    const semNumero2 = { ...makeFlightOffer(), flightNumber: '', fareCash: 418.65 }

    await svc.processCallback(makeCallback({ flights: [semNumero1, semNumero2] as never }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares).toHaveLength(2)
    expect(calledFares.map((f: { flight_number: unknown }) => f.flight_number)).toEqual([null, null])
  })

  // ── direction of the return leg ──────────────────────────────────────────────

  it('volta com a rota da ida é descartada, e a ida da mesma coleta fica', async () => {
    // Portrait of request 8be20a19: the LATAM returns screen did not advance, the
    // scraper read the OUTBOUND cards and stamped isReturn. The pair closed the flight
    // with itself — R$730.65 + R$730.65 on a single one-way leg.
    const job = makeJob({ flight_date: '2026-08-15' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    const ida = makeFlightOffer()
    const voltaFantasma = {
      ...makeFlightOffer(),
      isReturn: true, origin: 'VCP', destination: 'LIS',
      pairedOutboundFlight: 'AD1234',
    }

    await svc.processCallback(makeCallback({ flights: [ida, voltaFantasma] as never }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares).toHaveLength(1)
    expect(calledFares[0]).toMatchObject({ flight_number: 'AD1234', is_return: false })
  })

  it('volta que pousa em outro aeroporto da cidade é preservada', async () => {
    // BA returns 21 LCY→GRU inbounds on a GRU→LHR search. The cut is by a route EQUAL
    // to the outbound; demanding the exact inverse would lose those.
    const job = makeJob({ origin: 'GRU', destination: 'LHR', flight_date: '2026-09-21' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    const volta = {
      ...makeFlightOffer(),
      flightNumber: 'BA247', isReturn: true, origin: 'LCY', destination: 'GRU',
      pairedOutboundFlight: 'BA246',
    }

    await svc.processCallback(makeCallback({
      origin: 'GRU', destination: 'LHR', flights: [volta] as never,
    }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares).toHaveLength(1)
    expect(calledFares[0]).toMatchObject({ flight_number: 'BA247', is_return: true })
  })

  it('só-volta continua gravando: a rotina inverte a rota, e a perna é ida', async () => {
    // Journey "Teste 3 VOLTA": a CNF→GRU one_way routine. The fares arrive with
    // isReturn=false, so the cut must not touch them.
    const job = makeJob({ origin: 'CNF', destination: 'GRU', flight_date: '2026-09-25' })
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)
    vi.mocked(mockFlightFaresRepo.insertMany).mockResolvedValue(1)
    vi.mocked(mockScrapingJobRepo.markSuccess).mockResolvedValue(undefined)

    const perna = {
      ...makeFlightOffer(),
      flightNumber: 'LA3553', isReturn: false, origin: 'CNF', destination: 'GRU',
    }

    await svc.processCallback(makeCallback({
      origin: 'CNF', destination: 'GRU', flights: [perna] as never,
    }))

    const [, , calledFares] = vi.mocked(mockFlightFaresRepo.insertMany).mock.calls[0]
    expect(calledFares).toHaveLength(1)
    expect(calledFares[0]).toMatchObject({ flight_number: 'LA3553', is_return: false })
  })
})

// ── lote ───────────────────────────────────────────────────────────────────────

/**
 * O lote existe para uma coisa: nenhum item volta sozinho para a fila.
 *
 * Enquanto o lote está vivo, o callback de item grava tarifa e fecha a corrida, mas
 * NÃO reagenda. Quem decide o destino dos itens é o fechamento — e é lá que se separa
 * o que conta retentativa do que não conta.
 */
describe('ScrapeService — lote', () => {
  const LOTE = 'batch-0000-0000-0000-000000000001'

  function makeSvcComLote(over: {
    batchStatus?: string
    items?: ScrapingJobRow[]
    /** Callbacks de item já recebidos. O caminho normal é o item chegar ANTES do
     *  fechamento — os dois vão pelo mesmo canal HTTP, nessa ordem. */
    received?: number
  } = {}) {
    const mocks = makeMocks()
    const batch = {
      id: LOTE, airline: 'azul', origin: 'VCP', destination: 'LIS',
      status: over.batchStatus ?? 'running', item_count: 1, received_count: over.received ?? 1,
      close_reason: null, superseded_by: null, attempt: 2,
      created_at: new Date(), closed_at: null,
    }
    mocks.mockBatchRepo.findById.mockResolvedValue(batch)
    mocks.mockBatchRepo.close.mockResolvedValue({ ...batch, status: 'completed' })
    mocks.mockBatchRepo.listItems.mockResolvedValue(over.items ?? [])
    const svc = new ScrapeService(
      mocks.mockScrapingJobRepo, mocks.mockFlightFaresRepo, mocks.mockAnalysisRunsRepo,
      mocks.mockFx, mocks.mockFareHistoryRepo, mocks.mockBatchRepo as never,
    )
    return { svc, ...mocks, batch }
  }

  const fechamento = (over: Partial<BatchCallback> = {}): BatchCallback => ({
    batchId: LOTE,
    airline: 'azul',
    closedAt: new Date().toISOString(),
    reason: 'completed',
    items: [],
    ...over,
  })

  it('falha de item em lote vivo é SEGURADA: nada de retry nem de next_run_at', async () => {
    const job = makeJob({ batch_id: LOTE })
    const { svc, mockScrapingJobRepo } = makeSvcComLote()
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)

    await svc.processCallback(makeCallback({ flights: [], error: 'sem cards' }))

    expect(mockScrapingJobRepo.holdForBatch).toHaveBeenCalledWith(job.id, expect.stringContaining('sem cards'))
    expect(mockScrapingJobRepo.markFailed).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.markDead).not.toHaveBeenCalled()
  })

  // A página de erro da LATAM não é bloqueio, e num lote ela não pode derrubar os
  // irmãos: chamar isso de bloqueio pausou a companhia 3x em 2026-08-20.
  it('SITE_ERROR em lote vivo também é segurado, sem pausar a companhia', async () => {
    const job = makeJob({ batch_id: LOTE })
    const { svc, mockScrapingJobRepo } = makeSvcComLote()
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      flights: [], outcome: { state: 'SITE_ERROR', reason: 'busca demorou' },
    }))

    expect(mockScrapingJobRepo.holdForBatch).toHaveBeenCalled()
    expect(mockScrapingJobRepo.markSiteError).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.pauseAirlineForBlock).not.toHaveBeenCalled()
  })

  it('bloqueio fecha os lotes vivos da companhia ANTES de pausá-la', async () => {
    const job = makeJob({ batch_id: LOTE })
    const { svc, mockScrapingJobRepo, mockBatchRepo } = makeSvcComLote()
    vi.mocked(mockScrapingJobRepo.findByRequestId).mockResolvedValue(job)

    await svc.processCallback(makeCallback({
      flights: [], outcome: { state: 'BLOCKED', reason: 'akamai' },
    }))

    expect(mockBatchRepo.closeLiveByAirline).toHaveBeenCalledWith('azul', expect.stringContaining('bloqueio'))
    expect(mockScrapingJobRepo.pauseAirlineForBlock).toHaveBeenCalled()
  })

  it('fechamento normal: item que falhou conta retentativa, com o backoff DO LOTE', async () => {
    const job = makeJob({ batch_id: LOTE, request_id: 'req-1' })
    const { svc, mockScrapingJobRepo } = makeSvcComLote({ items: [job] })

    await svc.processBatchCallback(fechamento({
      items: [{ requestId: 'req-1', state: 'failed', error: 'sem cards' }],
    }))

    expect(mockScrapingJobRepo.settleBatchItem).toHaveBeenCalledWith(
      job.id, expect.objectContaining({ penalise: true }),
    )
  })

  // Regra 4: a análise nova cobre as mesmas datas, então retentar o que sobrou é
  // trabalho jogado fora — e a culpa não é do item.
  it('supersede DESCARTA os itens com erro, sem penalidade e disponíveis já', async () => {
    const job = makeJob({ batch_id: LOTE, request_id: 'req-1' })
    const { svc, mockScrapingJobRepo } = makeSvcComLote({ items: [job] })

    await svc.processBatchCallback(fechamento({
      reason: 'superseded',
      items: [{ requestId: 'req-1', state: 'failed', error: 'sem cards' }],
    }))

    const [, opts] = vi.mocked(mockScrapingJobRepo.settleBatchItem).mock.calls[0]!
    expect(opts.penalise).toBe(false)
    expect(opts.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  // Sem isto, um bloqueio no item 3 de 8 queimaria retry_count em 5 itens que nunca
  // rodaram — e três noites assim levariam a rota inteira para 'dead'.
  it('item NUNCA TENTADO não conta retentativa', async () => {
    const job = makeJob({ batch_id: LOTE, request_id: 'req-1' })
    const { svc, mockScrapingJobRepo } = makeSvcComLote({ items: [job] })

    await svc.processBatchCallback(fechamento({
      reason: 'watchdog',
      items: [{ requestId: 'req-1', state: 'not_attempted', why: 'batch_deadline' }],
    }))

    expect(mockScrapingJobRepo.settleBatchItem).toHaveBeenCalledWith(
      job.id, expect.objectContaining({ penalise: false }),
    )
  })

  it('bloqueio não penaliza nenhum item do lote', async () => {
    const job = makeJob({ batch_id: LOTE, request_id: 'req-1' })
    const { svc, mockScrapingJobRepo } = makeSvcComLote({ items: [job] })

    await svc.processBatchCallback(fechamento({
      reason: 'blocked',
      items: [{ requestId: 'req-1', state: 'failed', error: 'akamai' }],
    }))

    expect(mockScrapingJobRepo.settleBatchItem).toHaveBeenCalledWith(
      job.id, expect.objectContaining({ penalise: false }),
    )
  })

  it('fechamento de lote já encerrado é ignorado (idempotente)', async () => {
    const { svc, mockScrapingJobRepo, mockBatchRepo } = makeSvcComLote({ batchStatus: 'completed' })

    await svc.processBatchCallback(fechamento())

    expect(mockBatchRepo.close).not.toHaveBeenCalled()
    expect(mockScrapingJobRepo.settleBatchItem).not.toHaveBeenCalled()
  })

  it('lote desconhecido não explode', async () => {
    const { svc, mockBatchRepo } = makeSvcComLote()
    mockBatchRepo.findById.mockResolvedValue(null)

    await expect(svc.processBatchCallback(fechamento())).resolves.toBeUndefined()
  })
})

/**
 * Achado rodando de verdade em 2026-09-03, na primeira corrida do lote.
 *
 * O banner de instalação do Playwright passou de 500 caracteres, o schema recusou o
 * fechamento inteiro com 422, e o lote ficou preso em `running` — com o worker
 * reenviando o mesmo 422 em laço e TODOS os itens da rota trancados fora do claim.
 *
 * Mensagem de erro é diagnóstico; fechamento é integridade. O schema corta a primeira
 * para salvar a segunda.
 */
describe('batchCallbackSchema — o fechamento nunca é recusado por tamanho', () => {
  const base = {
    batchId: '11111111-1111-4111-8111-111111111111',
    airline: 'ryanair',
    closedAt: new Date().toISOString(),
    reason: 'completed' as const,
  }

  it('trunca um erro gigante em vez de rejeitar o fechamento', () => {
    const parsed = batchCallbackSchema.parse({
      ...base,
      items: [{
        requestId: '22222222-2222-4222-8222-222222222222',
        state: 'failed',
        error: 'x'.repeat(5_000),
      }],
    })

    expect(parsed.items[0]!.error).toHaveLength(500)
  })

  it('trunca o `why` do item não tentado pelo mesmo motivo', () => {
    const parsed = batchCallbackSchema.parse({
      ...base,
      items: [{
        requestId: '22222222-2222-4222-8222-222222222222',
        state: 'not_attempted',
        why: 'y'.repeat(1_000),
      }],
    })

    expect(parsed.items[0]!.why).toHaveLength(120)
  })
})
