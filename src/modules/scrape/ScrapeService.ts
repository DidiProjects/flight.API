import { IScrapeService } from './interfaces/IScrapeService'
import { IScrapingJobRepository } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import { ScrapeCallback } from './schema'
import { calcNextRunAt, calcBackoffNextRunAt } from '../../services/scheduler/SchedulerService'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scrape' })

export class ScrapeService implements IScrapeService {
  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
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
      const nextRunAt = calcBackoffNextRunAt(job.retry_count)
      if (job.retry_count + 1 >= job.max_retries) {
        await this.scrapingJobRepo.markDead(job.id, data.error)
        log.error({ jobId: job.id, error: data.error }, 'scraping_job_dead')
      } else {
        await this.scrapingJobRepo.markFailed(job.id, data.error, nextRunAt)
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

    log.info({ jobId: job.id, faresCount: count }, 'scraping_job_success')
  }
}
