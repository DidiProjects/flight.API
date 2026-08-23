import { randomUUID } from 'crypto'
import { ISchedulerService } from './interfaces/ISchedulerService'
import { IScrapingJobRepository, ScrapingJobRow } from '../../modules/scraping-jobs/interfaces/IScrapingJobRepository'
import { IFlightFaresRepository } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { IAirportsRepository } from '../../modules/airports/interfaces/IAirportsRepository'
import { IAnalysisRunsRepository } from '../../modules/analysis-runs/interfaces/IAnalysisRunsRepository'
import { IFareHistoryRepository } from '../../modules/fare-history/interfaces/IFareHistoryRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { IEvaluationService } from '../evaluation/interfaces/IEvaluationService'
import { IScraperClient, ScraperBusyError } from '../scraper-client/IScraperClient'
import { ICancelDispatcher } from '../../realtime/workerGateway'
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
// Lease: the worker heartbeats every ~15s. With no heartbeat for longer than this,
// the job is taken as lost (worker dead/unavailable) and reclaimed with no penalty.
const LEASE_TIMEOUT_SEC = 90
// A 'running' job that never showed up in any heartbeat after this grace was
// never accepted by the worker → reclaimed with no penalty.
const LEASE_GRACE_SEC = 60
// Absolute execution ceiling (backstop for the scraper watchdog, which is ~18min).
const MAX_RUN_MIN = 25
// Runs with no callback are marked as failed after this (a safety net).
const STALE_RUN_TIMEOUT_MIN = 25

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

function calcNextRunAt(flightDate: string): Date {
  const days = daysBetween(new Date(), new Date(flightDate))
  const intervalMs =
    days <= 45 ? 1 * 60 * 60 * 1000 :
    days <= 90 ? 3 * 60 * 60 * 1000 :
                 6 * 60 * 60 * 1000
  // ±20% jitter desynchronises date grids that would reschedule at the same
  // instant, avoiding a thundering herd on every cadence cycle.
  const jitter = (Math.random() * 2 - 1) * intervalMs * 0.2
  return new Date(Date.now() + intervalMs + jitter)
}

function calcBackoffNextRunAt(retryCount: number): Date {
  const BASE_MS = 60_000
  const CAP_MS = 30 * 60_000
  const jitter = Math.random() * 30_000
  const delay = Math.min(CAP_MS, BASE_MS * Math.pow(2, retryCount)) + jitter
  return new Date(Date.now() + delay)
}

/**
 * Wait after a failure declared by the airline site.
 *
 * Starts further out and grows further out than the ordinary backoff: when the
 * airline's search does not respond, asking every minute only repeats the
 * question it already could not answer — and, from its side, it is an automated
 * session insisting.
 */
function calcSiteErrorNextRunAt(retryCount: number): Date {
  const BASE_MS = 5 * 60_000
  const CAP_MS = 60 * 60_000
  const jitter = Math.random() * 60_000
  const delay = Math.min(CAP_MS, BASE_MS * Math.pow(2, retryCount)) + jitter
  return new Date(Date.now() + delay)
}

export { calcNextRunAt, calcBackoffNextRunAt, calcSiteErrorNextRunAt }

export class SchedulerService implements ISchedulerService {
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>()
  // Daily bucket already processed by maintenance (aggregation/cleanup). Allows
  // catch-up: if the exact 02:00 tick is missed, it runs on the next tick.
  private lastMaintenanceBucket: string | null = null

  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly notifSvc: INotificationsService,
    private readonly evaluationSvc: IEvaluationService,
    private readonly env: Env,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
    private readonly scraperClient: IScraperClient,
    private readonly cancelDispatcher: ICancelDispatcher,
    private readonly airportsRepo: IAirportsRepository,
    private readonly fareHistoryRepo: IFareHistoryRepository,
  ) {}

  async pruneOrphans(): Promise<void> {
    try {
      const running = await this.scrapingJobRepo.findRunningOrphans()
      for (const job of running) {
        if (job.request_id) await this.cancelDispatcher.requestCancel(job.request_id)
      }
      const retired = await this.scrapingJobRepo.retireOrphans()
      if (running.length || retired) {
        log.info({ cancelledRunning: running.length, retired }, 'orphan jobs pruned')
      }
    } catch (err) {
      log.error({ err }, 'prune orphans error')
    }
  }

  private stopped = false
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  start(): void {
    this.stopped = false
    this.scheduleJobDerivation()
    this.scheduleJobDispatch()
    this.scheduleHeartbeat()
    this.scheduleEvaluation()
    this.scheduleDailyJobs()
  }

  // Graceful shutdown: stops scheduling/firing cycles. A tick already running
  // finishes; no new one is armed. Called on SIGTERM before closing HTTP/DB.
  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private arm(fn: () => void | Promise<void>, delay: number): void {
    if (this.stopped) return
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.stopped) return
      void fn()
    }, delay)
    this.timers.add(t)
  }

  async dispatchOne(routineId: string): Promise<void> {
    log.info({ routineId }, 'dispatchOne: manual dispatch requested')
    await this.scrapingJobRepo.upsertFromRoutine(routineId)

    // A manual dispatch targets the route of the routine and covers every eligible
    // date (up to the global in-flight ceiling). Being an explicit admin action, it
    // ignores the per-airline circuit breaker; the first real failure (busy/error)
    // interrupts the burst, avoiding hammering a broken airline.
    const cap = this.env.SCRAPE_MAX_IN_FLIGHT
    const perAirline = this.env.SCRAPE_MAX_IN_FLIGHT_PER_AIRLINE
    let dispatched = 0
    while (await this.scrapingJobRepo.countInFlight() < cap) {
      const job = await this.scrapingJobRepo.claimNextJobForRoutine(routineId)
      if (!job) break
      const result = await this.dispatchClaimedJob(job)
      if (result !== 'dispatched') break
      dispatched++

      // The manual burst was the worst case: on 2026-08-20 it sent all four jobs of
      // the routine at once, one second apart, and all four ended on the LATAM error
      // page. The remaining dates go out on the next tick — on a routine with two
      // airlines, the second one waits for that tick too.
      if (await this.scrapingJobRepo.countInFlightByAirline(job.airline) >= perAirline) {
        log.info({ routineId, airline: job.airline, dispatched }, 'dispatchOne: per-airline cap reached')
        break
      }
    }
    log.info({ routineId, dispatched }, 'dispatchOne: targeted dispatch done')
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

        const retired = await this.scrapingJobRepo.retireOrphans()
        if (retired > 0) log.info({ retired }, 'orphan jobs retired')
      } catch (err) {
        log.error({ err }, 'job derivation error')
      } finally {
        const jitter = (Math.random() * 2 - 1) * this.env.SCRAPE_INTERVAL_JITTER_MS
        const delay = Math.max(this.env.SCRAPE_INTERVAL_MS + jitter, 60_000)
        this.arm(tick,delay)
      }
    }
    const initial = this.env.SCRAPE_INTERVAL_MS + Math.random() * this.env.SCRAPE_INTERVAL_JITTER_MS
    this.arm(tick, initial)
  }

  // ---------------------------------------------------------------------------
  // Dispatch loop — runs every SCRAPE_INTERVAL_MS
  // ---------------------------------------------------------------------------

  private scheduleJobDispatch(): void {
    const tick = async () => {
      try {
        await this.dispatchForAirlines(this.env.SCRAPE_DISPATCH_BATCH)
      } catch (err) {
        log.error({ err }, 'dispatch loop error')
      } finally {
        const jitter = (Math.random() * 2 - 1) * this.env.SCRAPE_INTERVAL_JITTER_MS
        const delay = Math.max(this.env.SCRAPE_INTERVAL_MS + jitter, 60_000)
        this.arm(tick,delay)
      }
    }
    const initial = this.env.SCRAPE_INTERVAL_MS + Math.random() * this.env.SCRAPE_INTERVAL_JITTER_MS
    this.arm(tick, initial)
  }

  private async dispatchForAirlines(budget: number): Promise<void> {
    const cap = this.env.SCRAPE_MAX_IN_FLIGHT
    const perAirline = this.env.SCRAPE_MAX_IN_FLIGHT_PER_AIRLINE
    let inFlight = await this.scrapingJobRepo.countInFlight()
    const airlines = await this.scrapingJobRepo.getActiveAirlines()
    for (const airline of airlines) {
      for (let i = 0; i < budget; i++) {
        if (inFlight >= cap) {
          log.info({ inFlight, cap }, 'dispatch paused: in-flight cap reached')
          return
        }
        if (this.isCircuitOpen(airline)) {
          log.warn({ airline }, 'circuit_breaker_open: skipping airline')
          break
        }
        // Before the claim: claiming already marks the job as 'running', and giving
        // it back after finding it does not fit is expensive and moves next_run_at.
        const naCompanhia = await this.scrapingJobRepo.countInFlightByAirline(airline)
        if (naCompanhia >= perAirline) {
          log.info({ airline, naCompanhia, perAirline }, 'dispatch skipped: per-airline cap reached')
          break
        }
        const result = await this.dispatchNextJob(airline)
        if (result === 'dispatched') inFlight++
        else if (result === 'busy') {
          log.warn('dispatch paused: scraper queue full (503)')
          return
        } else break // 'empty' ou 'error': sem mais jobs/airline travada
      }
    }
  }

  private async dispatchNextJob(airline: string): Promise<'dispatched' | 'empty' | 'busy' | 'error'> {
    const job = await this.scrapingJobRepo.claimNextJob(airline)
    if (!job) return 'empty'
    return this.dispatchClaimedJob(job)
  }

  private async dispatchClaimedJob(job: ScrapingJobRow): Promise<'dispatched' | 'busy' | 'error'> {
    const requestId = randomUUID()
    const flightDate = typeof job.flight_date === 'string'
      ? job.flight_date.slice(0, 10)
      : (job.flight_date as unknown as Date).toISOString().slice(0, 10)

    const [originCountry, destinationCountry] = await Promise.all([
      this.airportsRepo.getCountryCode(job.origin),
      this.airportsRepo.getCountryCode(job.destination),
    ])

    // Pair job: sends both dates so the scraper does ONE round-trip search, which
    // is the only way the bundle discount shows up.
    const returnDate = job.return_date == null
      ? null
      : typeof job.return_date === 'string'
        ? job.return_date.slice(0, 10)
        : (job.return_date as unknown as Date).toISOString().slice(0, 10)

    const payload = {
      requestId,
      routineId:     job.id,
      airline:       job.airline,
      origin:        job.origin,
      destination:   job.destination,
      outboundStart: flightDate,
      outboundEnd:   flightDate,
      returnStart:   returnDate ?? undefined,
      returnEnd:     returnDate ?? undefined,
      passengers:    1,
      originCountry:      originCountry ?? undefined,
      destinationCountry: destinationCountry ?? undefined,
    }

    const runData = { jobId: job.id, requestId, airline: job.airline, origin: job.origin, destination: job.destination, flightDate, returnDate }

    try {
      await this.scraperClient.dispatch(payload)
    } catch (err) {
      // Queue full: holds the job (pending) with no penalty and stops the dispatch.
      if (err instanceof ScraperBusyError) {
        await this.scrapingJobRepo.deferJob(job.id, new Date(Date.now() + err.retryAfterMs))
        log.info({ jobId: job.id, retryAfterMs: err.retryAfterMs }, 'dispatch deferred: scraper queue full')
        return 'busy'
      }
      // Real dispatch failure: records the attempt and applies backoff/dead.
      this.recordFailure(job.airline)
      await this.analysisRunsRepo.insertRunning(runData)
      if (job.retry_count + 1 >= job.max_retries) {
        await this.scrapingJobRepo.markDead(job.id, String(err))
        await this.analysisRunsRepo.markFinished(requestId, { status: 'dead', errorMessage: String(err) })
        log.error({ jobId: job.id, airline: job.airline, err }, 'scraping_job_dead: max retries reached on dispatch')
      } else {
        await this.scrapingJobRepo.markFailed(job.id, String(err), calcBackoffNextRunAt(job.retry_count))
        await this.analysisRunsRepo.markFinished(requestId, { status: 'failed', errorMessage: String(err) })
        log.error({ jobId: job.id, airline: job.airline, err }, 'scraping.API request failed')
      }
      return 'error'
    }

    // 202 accepted: only now does the job "exist" for the scraper — ties request_id and run.
    await this.scrapingJobRepo.markRunning(job.id, requestId)
    await this.analysisRunsRepo.insertRunning(runData)
    this.recordSuccess(job.airline)
    log.info({
      jobId: job.id, airline: job.airline, origin: job.origin,
      destination: job.destination, flight_date: job.flight_date, requestId,
    }, 'scraping_job_dispatched')
    return 'dispatched'
  }

  // ---------------------------------------------------------------------------
  // Heartbeat — runs every 2 minutes
  // ---------------------------------------------------------------------------

  private scheduleHeartbeat(): void {
    const tick = async () => {
      try {
        await this.runHeartbeatCycle()
      } catch (err) {
        log.error({ err }, 'heartbeat error')
      } finally {
        this.arm(tick,HEARTBEAT_INTERVAL_MS)
      }
    }
    this.arm(tick, HEARTBEAT_INTERVAL_MS)
  }

  // Lease-based reconciliation: reclaims jobs whose worker disappeared (lost, no
  // penalty) or that blew the absolute ceiling (hung, with penalty). Jobs still
  // alive in the worker keep heartbeating and are NOT touched.
  async runHeartbeatCycle(): Promise<void> {
    const { lost, hung } = await this.scrapingJobRepo.reclaimExpiredJobs(
      LEASE_TIMEOUT_SEC, LEASE_GRACE_SEC, MAX_RUN_MIN,
    )

    for (const requestId of [...lost, ...hung]) {
      await this.cancelDispatcher.requestCancel(requestId).catch(() => {})
    }
    for (const requestId of lost) {
      await this.analysisRunsRepo
        .markFinished(requestId, { status: 'failed', errorMessage: 'Lease expirado: worker indisponível (re-enfileirado)' })
        .catch(() => {})
    }
    for (const requestId of hung) {
      await this.analysisRunsRepo
        .markFinished(requestId, { status: 'failed', errorMessage: 'Excedeu o tempo máximo de execução' })
        .catch(() => {})
    }
    if (lost.length || hung.length) log.info({ lost: lost.length, hung: hung.length }, 'lease_reclaim')

    const staleRuns = await this.analysisRunsRepo.failStaleRunning(STALE_RUN_TIMEOUT_MIN)
    if (staleRuns > 0) log.info({ staleRuns }, 'heartbeat: stale analysis_runs failed')
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
        this.arm(tick,EVALUATION_INTERVAL_MS)
      }
    }
    this.arm(tick, EVALUATION_INTERVAL_MS)
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
        this.arm(tick,DAILY_TICK_INTERVAL_MS)
      }
    }
    this.arm(tick, DAILY_TICK_INTERVAL_MS)
  }

  private async runDailyTasks(): Promise<void> {
    await this.notifSvc.sendScheduled()

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(now)

    // Daily maintenance from 02:00, at most once a day. Instead of demanding the
    // exact minute (which a missed/late tick would skip forever), it runs on the
    // first tick after 02:00 whose bucket has not been processed.
    if (d.getHours() >= 2) {
      const yesterday = new Date(d)
      yesterday.setDate(yesterday.getDate() - 1)
      const bucketDate = yesterday.toISOString().slice(0, 10)

      if (this.lastMaintenanceBucket !== bucketDate) {
        // Marked before running so it is not duplicated if maintenance outlasts the tick.
        this.lastMaintenanceBucket = bucketDate
        await this.runDailyMaintenance(bucketDate)
      }
    }
  }

  private async runDailyMaintenance(bucketDate: string): Promise<void> {
    const aggregated = await this.flightFaresRepo.aggregateToDailyBucket(bucketDate)
    log.info({ bucketDate, aggregated }, 'daily bucket aggregated')

    const deleted = await this.flightFaresRepo.cleanupOlderThan(30)
    log.info({ deleted }, 'flight_fares cleanup: old raw data removed')

    const runsDeleted = await this.analysisRunsRepo.cleanupOlderThan(60)
    log.info({ runsDeleted }, 'analysis_runs cleanup: old runs removed')

    // The event timeline has a shorter retention (high cardinality).
    const eventsDeleted = await this.analysisRunsRepo.cleanupEventsOlderThan(15)
    log.info({ eventsDeleted }, 'analysis_run_events cleanup: old timeline removed')

    const deadCleaned = await this.scrapingJobRepo.cleanupDeadJobs()
    log.info({ deadCleaned }, 'scraping_jobs cleanup: dead jobs removed')

    const alertStateCleaned = await this.evaluationSvc.cleanupAlertState()
    log.info({ alertStateCleaned }, 'target_alert_state cleanup: past-date cells removed')

    // Itineraries off the radar for a month. Their history goes with them
    // (CASCADE): a flight that no longer sells has a series nobody reads.
    const itinerariesCleaned = await this.fareHistoryRepo.cleanupNotSeenSince(30)
    log.info({ itinerariesCleaned }, 'fare_itineraries cleanup: stale itineraries removed')
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
