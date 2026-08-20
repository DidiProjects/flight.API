import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScrapeService } from './ScrapeService'
import type { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import type { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import type { IAnalysisRunsRepository } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import type { IFxRateService } from '../../services/fx/interfaces/IFxRateService'
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
    pauseAirlineForBlock: vi.fn(),
  } satisfies Partial<IScrapingJobRepository> as unknown as IScrapingJobRepository

  const mockFlightFaresRepo = {
    insertMany: vi.fn(),
  } satisfies Partial<IFlightFaresRepository> as unknown as IFlightFaresRepository

  const mockAnalysisRunsRepo = {
    insertRunning: vi.fn(),
    markFinished:  vi.fn(),
  } satisfies Partial<IAnalysisRunsRepository> as unknown as IAnalysisRunsRepository

  // Câmbio fixo e determinístico: BRL não converte, GBP vale 7. Os testes deste
  // arquivo verificam o mapeamento das fares, não a cotação — mas a conversão
  // agora acontece na ingestão (017) e precisa de um provedor.
  const mockFx = {
    toBrl: vi.fn(async (amount: number, currency: string) =>
      currency === 'BRL'
        ? { amount, rate: 1, source: 'native' as const, rateDate: '2026-08-20', stale: false }
        : { amount: amount * 7, rate: 7, source: 'frankfurter' as const, rateDate: '2026-08-20', stale: false },
    ),
    convert: vi.fn(),
  } satisfies Partial<IFxRateService> as unknown as IFxRateService

  return { mockScrapingJobRepo, mockFlightFaresRepo, mockAnalysisRunsRepo, mockFx }
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
    svc = new ScrapeService(mockScrapingJobRepo, mockFlightFaresRepo, mockAnalysisRunsRepo, mocks.mockFx)
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
    // request_id da execução é repassado para virar o discriminador de snapshot
    // no flight_fares (sem ele, re-coletas da mesma rota congelariam o preço).
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
    // O vinculo existe SO na volta; guardar na ida corromperia o agrupamento.
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
    // A limitacao e da IDA: as voltas DELA nao abriram.
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

  // ── moeda obrigatória ────────────────────────────────────────────────────────

  it('oferta sem moeda é descartada, e as boas da mesma coleta são gravadas', async () => {
    // `flight_fares.currency` é NOT NULL e o insert é UM comando multi-linha:
    // sem este filtro, uma oferta ruim abortaria o lote e a coleta inteira se
    // perderia por causa de uma linha.
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

  // ── número de voo ilegível ───────────────────────────────────────────────────

  it('número de voo vazio vira NULL, e duas leituras falhas não colidem na dedup', async () => {
    // O scraper da LATAM usa '' quando o modal não abre. O índice único de dedup
    // só ignora NULL, então duas linhas com '' colidiam na chave e a segunda era
    // descartada — perdendo uma tarifa real por não saber o número dela.
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

  // ── direção da perna de volta ────────────────────────────────────────────────

  it('volta com a rota da ida é descartada, e a ida da mesma coleta fica', async () => {
    // Retrato do request 8be20a19: a tela de voltas da LATAM não avançou, o
    // scraper leu os cards de IDA e carimbou isReturn. O par fechava o voo com
    // ele mesmo — R$730,65 + R$730,65 num trecho só de ida.
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
    // A BA devolve 21 voltas LCY→GRU numa busca GRU→LHR. O corte é por rota
    // IGUAL à da ida; exigir o inverso exato perderia essas.
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
    // Jornada "Teste 3 VOLTA": rotina CNF→GRU one_way. As tarifas chegam com
    // isReturn=false, então o corte não pode encostar nelas.
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
