import { IScrapeService } from './interfaces/IScrapeService'
import { IScrapingJobRepository } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import { IAnalysisRunsRepository } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import { ScrapeCallback } from './schema'
import { calcNextRunAt, calcBackoffNextRunAt } from '../../services/scheduler/SchedulerService'
import { IFxRateService } from '../../services/fx/interfaces/IFxRateService'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scrape' })

// An IP/bot block affects the whole airline. Pause every job of that airline for
// this long instead of retrying job-by-job (which only prolongs the block).
const BLOCK_COOLDOWN_MS = 60 * 60 * 1000

function isBlockError(error: string): boolean {
  return /bot|block|ip[\s/_-]?block|captcha|detection|acesso foi limitado|comportamento incomum/i.test(error)
}

/** DATE do pg volta como string ou Date; normaliza para YYYY-MM-DD ou null. */
function toDateOrNull(v: string | Date | null): string | null {
  if (v == null) return null
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

export class ScrapeService implements IScrapeService {
  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
    private readonly fx: IFxRateService,
  ) {}

  /**
   * Converte as tarifas para Real UMA vez, aqui, na ingestão da análise.
   *
   * A taxa fica gravada na linha: o histórico passa a refletir o câmbio de
   * quando a rotina rodou, e não o de hoje. Antes a conversão era na leitura, e
   * a régua de 30 dias se mexia sozinha — queda da libra virava "o voo
   * baratear".
   *
   * Uma cotação por MOEDA, não por linha: o cache do FxRateService é por
   * moeda-dia, então as 40 tarifas de uma coleta custam uma consulta.
   *
   * Sem cotação a linha entra com `null` em vez de ser recusada. Perder o preço
   * porque o câmbio piscou seria pior que gravá-lo sem o valor em Real — a
   * moeda original continua lá, e as somas em Real simplesmente ignoram a linha.
   */
  private async withBrl<T extends { currency: string | null; fare_cash: number | null; fare_hyb_cash: number | null }>(
    rows: T[],
    logCtx: Record<string, unknown>,
  ): Promise<(T & { fare_cash_brl: number | null; fare_hyb_cash_brl: number | null; fx_rate: number | null; fx_rate_date: string | null })[]> {
    const moedas = [...new Set(rows.map(r => r.currency).filter((c): c is string => c != null))]
    const cotacoes = new Map<string, { rate: number; rateDate: string }>()

    for (const moeda of moedas) {
      const conv = await this.fx.toBrl(1, moeda)
      if (conv == null) {
        log.warn({ ...logCtx, currency: moeda }, 'scrape: sem cotação — tarifas gravadas sem valor em Real')
        continue
      }
      cotacoes.set(moeda, { rate: conv.rate, rateDate: conv.rateDate })
    }

    const arredonda = (v: number) => Math.round(v * 100) / 100

    return rows.map((r) => {
      const cot = r.currency ? cotacoes.get(r.currency) : undefined
      if (!cot) return { ...r, fare_cash_brl: null, fare_hyb_cash_brl: null, fx_rate: null, fx_rate_date: null }
      return {
        ...r,
        fare_cash_brl:     r.fare_cash     == null ? null : arredonda(r.fare_cash * cot.rate),
        fare_hyb_cash_brl: r.fare_hyb_cash == null ? null : arredonda(r.fare_hyb_cash * cot.rate),
        fx_rate:           cot.rate,
        fx_rate_date:      cot.rateDate,
      }
    })
  }

  async processCallback(data: ScrapeCallback): Promise<void> {
    log.info({
      requestId:    data.requestId,
      routineId:    data.routineId,
      airline:      data.airline,
      origin:       data.origin,
      destination:  data.destination,
      flightCount:  data.flights.length,
      hasError:     !!data.error,
      scrapedAt:    data.scrapedAt,
    }, 'scrape callback received')

    const job = await this.scrapingJobRepo.findByRequestId(data.requestId)
    if (!job) {
      await this.handleOrphanCallback(data)
      return
    }

    if (data.error && data.flights.length === 0) {
      // IP/bot block: pause the whole airline for a cooldown. Do NOT escalate to
      // dead — the block is not the job's fault.
      if (isBlockError(data.error)) {
        const until = new Date(Date.now() + BLOCK_COOLDOWN_MS)
        const paused = await this.scrapingJobRepo.pauseAirlineForBlock(job.airline, until, data.error)
        await this.analysisRunsRepo.markFinished(data.requestId, { status: 'blocked', errorMessage: data.error })
        log.warn({ jobId: job.id, airline: job.airline, paused, until }, 'scraping_airline_blocked: airline paused')
        return
      }

      const nextRunAt = calcBackoffNextRunAt(job.retry_count)
      if (job.retry_count + 1 >= job.max_retries) {
        await this.scrapingJobRepo.markDead(job.id, data.error)
        await this.analysisRunsRepo.markFinished(data.requestId, { status: 'dead', errorMessage: data.error })
        log.error({ jobId: job.id, error: data.error }, 'scraping_job_dead')
      } else {
        await this.scrapingJobRepo.markFailed(job.id, data.error, nextRunAt)
        await this.analysisRunsRepo.markFinished(data.requestId, { status: 'failed', errorMessage: data.error })
        log.warn({ jobId: job.id, retryCount: job.retry_count + 1 }, 'scraping_job_failed')
      }
      return
    }

    const rows  = await this.withBrl(this.toFareRows(data, toDateOrNull(job.return_date)), { requestId: data.requestId, airline: data.airline })
    const count = await this.flightFaresRepo.insertMany(job.id, data.requestId, rows)

    const nextRunAt = calcNextRunAt(job.flight_date)
    await this.scrapingJobRepo.markSuccess(job.id, nextRunAt)
    await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })

    log.info({ jobId: job.id, faresCount: count }, 'scraping_job_success')
  }

  // Callback cujo request_id não bate com nenhum job: o job já foi recuperado
  // (timeout) e re-despachado, ou é duplicado/atrasado. O payload carrega o id
  // do scraping_job em `routineId`, então tentamos reidratar por ele para não
  // perder a coleta nem deixar a analysis_run presa em 'running'.
  private async handleOrphanCallback(data: ScrapeCallback): Promise<void> {
    const job = data.routineId
      ? await this.scrapingJobRepo.findById(data.routineId)
      : null

    // Erro sem voos: só fecha a run; não mexe no job (ele já seguiu adiante).
    if (data.error && data.flights.length === 0) {
      await this.analysisRunsRepo.markFinished(data.requestId, {
        status:       isBlockError(data.error) ? 'blocked' : 'failed',
        errorMessage: data.error,
      })
      log.warn({ requestId: data.requestId, jobId: job?.id }, 'orphan callback (erro): run fechada, job intocado')
      return
    }

    if (!job) {
      // Sem job não há scraping_job_id para amarrar as fares — só fecha a run.
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })
      log.warn({ requestId: data.requestId }, 'orphan callback: job não encontrado, fares descartadas')
      return
    }

    // Persiste a coleta (ON CONFLICT protege contra duplicata na mesma execução).
    const rows  = await this.withBrl(this.toFareRows(data, toDateOrNull(job.return_date)), { requestId: data.requestId, airline: data.airline })
    const count = await this.flightFaresRepo.insertMany(job.id, data.requestId, rows)

    // Só reagenda o job se ele NÃO estiver no meio de uma nova coleta (re-despacho
    // já em voo com outro request_id) — nesse caso evitamos sobrescrever o estado.
    const jobMovedOn = job.status === 'running' && job.request_id !== data.requestId
    if (!jobMovedOn) {
      await this.scrapingJobRepo.markSuccess(job.id, calcNextRunAt(job.flight_date))
    }
    await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })

    log.info({ jobId: job.id, faresCount: count, jobMovedOn }, 'orphan callback: coleta salva')
  }

  /**
   * O `return_date` vem do JOB, não do callback: o job é quem define o par que
   * foi buscado. Sem este carimbo a tarifa colhida numa busca ida-e-volta ficaria
   * indistinguível de uma avulsa e voltaria a ser reaproveitada como se fosse.
   */
  private toFareRows(data: ScrapeCallback, returnDate: string | null) {
    // Tarifa sem moeda não entra. A `scraping.API` já descarta na origem, mas a
    // garantia tem que existir deste lado também: a coluna é NOT NULL e o INSERT
    // é UM comando multi-linha — uma oferta ruim abortaria o lote inteiro e a
    // coleta toda se perderia por causa de uma linha.
    //
    // Filtrar em vez de recusar o callback é deliberado: o erro é de quem
    // coletou, e perder 1 oferta é melhor que perder as 44 da mesma busca.
    const comMoeda = data.flights.filter((f) => f.currency != null && f.currency.length === 3)
    const dropped = data.flights.length - comMoeda.length
    if (dropped > 0) {
      log.warn({
        requestId:   data.requestId,
        airline:     data.airline,
        origin:      data.origin,
        destination: data.destination,
        dropped,
        received:    data.flights.length,
      }, 'scrape: ofertas sem moeda descartadas antes de persistir')
    }

    // Volta com a MESMA rota da busca é a lista de idas lida como se fosse a de
    // voltas — o par fecharia a ida com ela mesma e somaria dois trechos na
    // mesma direção. O scraper já corta na origem; aqui é a rede, porque o dado
    // errado é indistinguível do certo depois de gravado.
    //
    // O critério é rota IGUAL à da ida, não rota exatamente invertida: a BA
    // devolve 21 voltas LCY→GRU numa busca GRU→LHR, e exigir o inverso exato
    // descartaria volta legítima de qualquer companhia multi-aeroporto.
    const usable = comMoeda.filter(
      (f) => !(f.isReturn && f.origin === data.origin && f.destination === data.destination),
    )
    const mesmaDirecao = comMoeda.length - usable.length
    if (mesmaDirecao > 0) {
      log.warn({
        requestId:   data.requestId,
        airline:     data.airline,
        origin:      data.origin,
        destination: data.destination,
        dropped:     mesmaDirecao,
      }, 'scrape: voltas com a rota da ida descartadas antes de persistir')
    }

    return usable.map((f) => ({
      // `|| null`, não `?? null`: o scraper usa string vazia para "não consegui
      // ler o número do voo", e ela passava direto. O índice único de dedup só
      // exclui NULL (`WHERE flight_number IS NOT NULL`), então duas leituras
      // falhas na mesma coleta colidiam na chave e a segunda era silenciosamente
      // descartada — perdendo uma tarifa real por não saber o número dela.
      flight_number:  f.flightNumber || null,
      flight_date:    f.date,
      is_return:      f.isReturn,
      origin:         f.origin,
      destination:    f.destination,
      airline:        f.airline,
      departure_time: f.departureTime ?? null,
      arrival_time:   f.arrivalTime ?? null,
      duration_min:   f.durationMin ?? null,
      stops:          f.stops ?? null,
      currency:       f.currency ?? null,
      fare_cash:      f.fareCash ?? null,
      fare_pts:       f.farePts ?? null,
      fare_hyb_pts:   f.fareHybPts ?? null,
      fare_hyb_cash:  f.fareHybCash ?? null,
      return_date:    returnDate,
      // Vínculo 1-para-N: só as voltas carregam a ida que as precificou.
      paired_outbound_flight: f.isReturn ? (f.pairedOutboundFlight ?? null) : null,
      // Volta indefinida é propriedade da IDA (as voltas DELA não abriram).
      inbound_unavailable:    !f.isReturn && f.inboundUnavailable === true,
    }))
  }
}
