import { IScrapeService } from './interfaces/IScrapeService'
import { IScrapingJobRepository } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import { IAnalysisRunsRepository } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import { ScrapeCallback } from './schema'
import { calcNextRunAt, calcBackoffNextRunAt } from '../../services/scheduler/SchedulerService'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scrape' })

// An IP/bot block affects the whole airline. Pause every job of that airline for
// this long instead of retrying job-by-job (which only prolongs the block).
const BLOCK_COOLDOWN_MS = 60 * 60 * 1000

function isBlockError(error: string): boolean {
  return /bot|block|ip[\s/_-]?block|captcha|detection|acesso foi limitado|comportamento incomum/i.test(error)
}

export class ScrapeService implements IScrapeService {
  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
  ) {}

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

    const count = await this.flightFaresRepo.insertMany(job.id, data.requestId, this.toFareRows(data))

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
    const count = await this.flightFaresRepo.insertMany(job.id, data.requestId, this.toFareRows(data))

    // Só reagenda o job se ele NÃO estiver no meio de uma nova coleta (re-despacho
    // já em voo com outro request_id) — nesse caso evitamos sobrescrever o estado.
    const jobMovedOn = job.status === 'running' && job.request_id !== data.requestId
    if (!jobMovedOn) {
      await this.scrapingJobRepo.markSuccess(job.id, calcNextRunAt(job.flight_date))
    }
    await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })

    log.info({ jobId: job.id, faresCount: count, jobMovedOn }, 'orphan callback: coleta salva')
  }

  private toFareRows(data: ScrapeCallback) {
    return data.flights.map((f) => ({
      flight_number:  f.flightNumber ?? null,
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
    }))
  }
}
