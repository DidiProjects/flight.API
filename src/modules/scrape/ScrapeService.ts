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
      log.warn({ requestId: data.requestId }, 'scrape callback: job not found')
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

    const fares = data.flights.map((f) => ({
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

    const count = await this.flightFaresRepo.insertMany(job.id, fares)

    const nextRunAt = calcNextRunAt(job.flight_date)
    await this.scrapingJobRepo.markSuccess(job.id, nextRunAt)
    await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })

    log.info({ jobId: job.id, faresCount: count }, 'scraping_job_success')
  }
}
