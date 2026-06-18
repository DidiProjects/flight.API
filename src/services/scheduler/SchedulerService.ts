import { randomUUID } from 'crypto'
import { ISchedulerService } from './interfaces/ISchedulerService'
import { IScrapingJobRepository, ScrapingJobRow } from '../../modules/scraping-jobs/interfaces/IScrapingJobRepository'
import { IFlightFaresRepository } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { IAnalysisRunsRepository } from '../../modules/analysis-runs/interfaces/IAnalysisRunsRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { IEvaluationService } from '../evaluation/interfaces/IEvaluationService'
import { Env } from '../../config/env'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scheduler' })

interface CircuitBreakerState {
  failures: number
  state: 'closed' | 'open' | 'half-open'
  openedAt?: number
}

const CIRCUIT_THRESHOLD = 5
const CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000
const EVALUATION_INTERVAL_MS = 5 * 60 * 1000
const DAILY_TICK_INTERVAL_MS = 60_000
// Runs sem callback (scraper travou/sumiu) são marcadas como falha após esse tempo.
// Maior que o running_timeout_min do job (10min) para dar margem ao recovery normal.
const STALE_RUN_TIMEOUT_MIN = 15

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

function calcNextRunAt(flightDate: string): Date {
  const days = daysBetween(new Date(), new Date(flightDate))
  const intervalMs =
    days <= 7  ? 2  * 60 * 60 * 1000 :
    days <= 14 ? 3  * 60 * 60 * 1000 :
    days <= 30 ? 6  * 60 * 60 * 1000 :
    days <= 60 ? 12 * 60 * 60 * 1000 :
                 24 * 60 * 60 * 1000
  return new Date(Date.now() + intervalMs)
}

function calcBackoffNextRunAt(retryCount: number): Date {
  const BASE_MS = 60_000
  const CAP_MS = 30 * 60_000
  const jitter = Math.random() * 30_000
  const delay = Math.min(CAP_MS, BASE_MS * Math.pow(2, retryCount)) + jitter
  return new Date(Date.now() + delay)
}

export { calcNextRunAt, calcBackoffNextRunAt }

export class SchedulerService implements ISchedulerService {
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>()

  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly notifSvc: INotificationsService,
    private readonly evaluationSvc: IEvaluationService,
    private readonly env: Env,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
  ) {}

  start(): void {
    this.scheduleJobDerivation()
    this.scheduleJobDispatch()
    this.scheduleHeartbeat()
    this.scheduleEvaluation()
    this.scheduleDailyJobs()
  }

  async dispatchOne(routineId: string): Promise<void> {
    log.info({ routineId }, 'dispatchOne: manual dispatch requested')
    await this.scrapingJobRepo.upsertFromRoutine(routineId)
    await this.dispatchForAirlines()
  }

  // ---------------------------------------------------------------------------
  // Job derivation loop — runs every SCRAPE_INTERVAL_MS
  // ---------------------------------------------------------------------------

  private scheduleJobDerivation(): void {
    const tick = async () => {
      try {
        const expired = await this.scrapingJobRepo.expireOldJobs()
        if (expired > 0) log.info({ expired }, 'scraping jobs expired')

        const upserted = await this.scrapingJobRepo.upsertFromRoutines()
        if (upserted > 0) log.info({ upserted }, 'scraping jobs upserted from routines')

        await this.scrapingJobRepo.updatePriorities()
      } catch (err) {
        log.error({ err }, 'job derivation error')
      } finally {
        const jitter = (Math.random() * 2 - 1) * this.env.SCRAPE_INTERVAL_JITTER_MS
        const delay = Math.max(this.env.SCRAPE_INTERVAL_MS + jitter, 60_000)
        setTimeout(tick, delay)
      }
    }
    const initial = this.env.SCRAPE_INTERVAL_MS + Math.random() * this.env.SCRAPE_INTERVAL_JITTER_MS
    setTimeout(tick, initial)
  }

  // ---------------------------------------------------------------------------
  // Dispatch loop — runs every SCRAPE_INTERVAL_MS
  // ---------------------------------------------------------------------------

  private scheduleJobDispatch(): void {
    const tick = async () => {
      try {
        await this.dispatchForAirlines()
      } catch (err) {
        log.error({ err }, 'dispatch loop error')
      } finally {
        const jitter = (Math.random() * 2 - 1) * this.env.SCRAPE_INTERVAL_JITTER_MS
        const delay = Math.max(this.env.SCRAPE_INTERVAL_MS + jitter, 60_000)
        setTimeout(tick, delay)
      }
    }
    const initial = this.env.SCRAPE_INTERVAL_MS + Math.random() * this.env.SCRAPE_INTERVAL_JITTER_MS
    setTimeout(tick, initial)
  }

  private async dispatchForAirlines(): Promise<void> {
    const airlines = await this.scrapingJobRepo.getActiveAirlines()
    for (const airline of airlines) {
      if (this.isCircuitOpen(airline)) {
        log.warn({ airline }, 'circuit_breaker_open: skipping airline')
        continue
      }
      await this.dispatchNextJob(airline)
    }
  }

  private async dispatchNextJob(airline: string): Promise<void> {
    const job = await this.scrapingJobRepo.claimNextJob(airline)
    if (!job) return

    log.info({ jobId: job.id, airline: job.airline, priority: job.priority }, 'scraping_job_claimed')

    const requestId = randomUUID()
    await this.scrapingJobRepo.markRunning(job.id, requestId)

    const flightDate = typeof job.flight_date === 'string'
      ? job.flight_date.slice(0, 10)
      : (job.flight_date as unknown as Date).toISOString().slice(0, 10)

    await this.analysisRunsRepo.insertRunning({
      jobId:       job.id,
      requestId,
      airline:     job.airline,
      origin:      job.origin,
      destination: job.destination,
      flightDate,
    })

    const payload = {
      requestId,
      routineId:     job.id,
      airline:       job.airline,
      origin:        job.origin,
      destination:   job.destination,
      outboundStart: flightDate,
      outboundEnd:   flightDate,
      passengers:    1,
    }

    log.info({
      airline:     job.airline,
      origin:      job.origin,
      destination: job.destination,
      flight_date: job.flight_date,
      requestId,
    }, 'scraping_job_dispatched')

    try {
      const res = await fetch(`${this.env.SCRAPING_API_URL}/scrape`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.env.SCRAPING_API_KEY },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`scraping.API ${res.status}: ${body}`)
      }
      this.recordSuccess(airline)
    } catch (err) {
      this.recordFailure(airline)
      const nextRunAt = calcBackoffNextRunAt(job.retry_count)
      if (job.retry_count + 1 >= job.max_retries) {
        await this.scrapingJobRepo.markDead(job.id, String(err))
        await this.analysisRunsRepo.markFinished(requestId, { status: 'dead', errorMessage: String(err) })
        log.error({ jobId: job.id, airline, err }, 'scraping_job_dead: max retries reached on dispatch')
      } else {
        await this.scrapingJobRepo.markFailed(job.id, String(err), nextRunAt)
        await this.analysisRunsRepo.markFinished(requestId, { status: 'failed', errorMessage: String(err) })
        log.error({ jobId: job.id, airline, err }, 'scraping.API request failed')
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat — runs every 2 minutes
  // ---------------------------------------------------------------------------

  private scheduleHeartbeat(): void {
    const tick = async () => {
      try {
        const count = await this.scrapingJobRepo.recoverStuckJobs()
        if (count > 0) log.info({ count }, 'heartbeat_recovered')

        const staleRuns = await this.analysisRunsRepo.failStaleRunning(STALE_RUN_TIMEOUT_MIN)
        if (staleRuns > 0) log.info({ staleRuns }, 'heartbeat: stale analysis_runs failed')
      } catch (err) {
        log.error({ err }, 'heartbeat error')
      } finally {
        setTimeout(tick, HEARTBEAT_INTERVAL_MS)
      }
    }
    setTimeout(tick, HEARTBEAT_INTERVAL_MS)
  }

  // ---------------------------------------------------------------------------
  // Evaluation loop — runs every 5 minutes
  // ---------------------------------------------------------------------------

  private scheduleEvaluation(): void {
    const tick = async () => {
      try {
        await this.evaluationSvc.runCycle()
      } catch (err) {
        log.error({ err }, 'evaluation loop error')
      } finally {
        setTimeout(tick, EVALUATION_INTERVAL_MS)
      }
    }
    setTimeout(tick, EVALUATION_INTERVAL_MS)
  }

  // ---------------------------------------------------------------------------
  // Daily jobs — tick every minute
  // ---------------------------------------------------------------------------

  private scheduleDailyJobs(): void {
    const tick = async () => {
      try {
        await this.runDailyTasks()
      } catch (err) {
        log.error({ err }, 'daily jobs error')
      } finally {
        setTimeout(tick, DAILY_TICK_INTERVAL_MS)
      }
    }
    setTimeout(tick, DAILY_TICK_INTERVAL_MS)
  }

  private async runDailyTasks(): Promise<void> {
    await this.notifSvc.sendScheduled()

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(now)
    const hours = d.getHours()
    const minutes = d.getMinutes()

    if (hours === 2 && minutes === 0) {
      const yesterday = new Date(d)
      yesterday.setDate(yesterday.getDate() - 1)
      const bucketDate = yesterday.toISOString().slice(0, 10)

      const aggregated = await this.flightFaresRepo.aggregateToDailyBucket(bucketDate)
      log.info({ bucketDate, aggregated }, 'daily bucket aggregated')

      const deleted = await this.flightFaresRepo.cleanupOlderThan(30)
      log.info({ deleted }, 'flight_fares cleanup: old raw data removed')

      const runsDeleted = await this.analysisRunsRepo.cleanupOlderThan(60)
      log.info({ runsDeleted }, 'analysis_runs cleanup: old runs removed')

      const deadCleaned = await this.scrapingJobRepo.cleanupDeadJobs()
      log.info({ deadCleaned }, 'scraping_jobs cleanup: dead jobs removed')
    }
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker
  // ---------------------------------------------------------------------------

  private isCircuitOpen(airline: string): boolean {
    const cb = this.circuitBreakers.get(airline)
    if (!cb) return false
    if (cb.state === 'open') {
      if (cb.openedAt && Date.now() - cb.openedAt > CIRCUIT_COOLDOWN_MS) {
        cb.state = 'half-open'
        return false
      }
      return true
    }
    return false
  }

  private recordSuccess(airline: string): void {
    const cb = this.circuitBreakers.get(airline)
    if (!cb) return
    if (cb.state === 'half-open') {
      log.info({ airline }, 'circuit_breaker_closed')
    }
    this.circuitBreakers.set(airline, { failures: 0, state: 'closed' })
  }

  private recordFailure(airline: string): void {
    const current = this.circuitBreakers.get(airline) ?? { failures: 0, state: 'closed' as const }
    const failures = current.failures + 1
    if (failures >= CIRCUIT_THRESHOLD) {
      log.warn({ airline, consecutiveFailures: failures }, 'circuit_breaker_open')
      this.circuitBreakers.set(airline, { failures, state: 'open', openedAt: Date.now() })
    } else {
      this.circuitBreakers.set(airline, { ...current, failures })
    }
  }
}
