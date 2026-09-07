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
import { ClaimedBatch, IScrapingBatchRepository } from '../../modules/scraping-batches/interfaces/IScrapingBatchRepository'
import { IAirlinesRepository } from '../../modules/airlines/interfaces/IAirlinesRepository'
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
// Absolute execution ceiling. It is the BACKSTOP of the scraper watchdog (40min for
// a batch), never the primary: whoever declares the end of a run has to be the side
// holding the evidence of what the screen was doing. Below the watchdog it would kill
// a healthy batch mid-item, with a live lease, and blame the item for it.
const MAX_RUN_MIN = 45
// Runs with no callback are marked as failed after this (a safety net).
const STALE_RUN_TIMEOUT_MIN = 45
// A batch older than this is force-closed even if the worker never reported: it is the
// third and last closing door (the first two are the worker's explicit signal and the
// per-item count).
const MAX_BATCH_RUN_MIN = 50

/** A pg DATE comes back as string or Date; normalise to YYYY-MM-DD. */
function toIsoDate(v: string | Date): string {
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10)
}

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
    private readonly batchRepo: IScrapingBatchRepository,
    private readonly airlinesRepo: IAirlinesRepository,
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

  /**
   * Manual dispatch by the admin. The ONE explicit "analyse this now" in the system:
   * `upsertFromRoutine` has no other caller, and routine create/update/remove only
   * touch the `routines` table — their jobs converge later, through the derivation
   * loop, with no urgency.
   *
   * Because it is explicit, it is also the one path allowed to supersede a live batch
   * of the same route: the operator asked for fresh numbers, so what is left of the
   * previous run is discarded instead of retried.
   *
   * It keeps ignoring the circuit breaker (explicit admin action) and keeps ignoring
   * `is_active` — the "inactive routine collects but never alerts" asymmetry was
   * decided on 2026-08-19 and batching is not the occasion to revisit it.
   */
  async dispatchOne(routineId: string): Promise<void> {
    log.info({ routineId }, 'dispatchOne: manual dispatch requested')
    await this.scrapingJobRepo.upsertFromRoutine(routineId)
    await this.supersedeLiveBatchesOfRoutine(routineId)

    const cap = this.env.SCRAPE_MAX_IN_FLIGHT
    const perAirline = this.env.SCRAPE_MAX_IN_FLIGHT_PER_AIRLINE
    let dispatched = 0

    // One batch per (airline, route) of the routine. The burst that used to fire every
    // date at once is gone by construction: the items of a batch are walked in series
    // inside one session. On 2026-08-20 that burst sent the routine's four jobs a
    // second apart and all four landed on the LATAM error page.
    while (await this.batchRepo.countLive() < cap) {
      const size = await this.batchSizeForRoutine(routineId)
      const claimed = await this.batchRepo.claimBatchForRoutine(routineId, size)
      if (!claimed) break

      const result = await this.dispatchBatch(claimed)
      if (result !== 'dispatched') break
      dispatched++

      if (await this.batchRepo.countLiveByAirline(claimed.batch.airline) >= perAirline) {
        log.info({ routineId, airline: claimed.batch.airline, dispatched }, 'dispatchOne: per-airline cap reached')
        break
      }
    }
    log.info({ routineId, dispatched }, 'dispatchOne: targeted dispatch done')
  }

  /**
   * Drops what is left of the live batches on the routes this routine covers.
   *
   * The batch is keyed by ROUTE, not by routine — `scraping_jobs` has no `routine_id`
   * and deduplicates by route — so "a new analysis of the same routine" is really "a
   * new analysis of the same route", possibly asked for through someone else's
   * routine. Written any other way the supersede simply would not fire.
   *
   * The new batch is NOT dispatched here. It waits for the worker to close the old one
   * at an item boundary: sending it now would put two sessions of the same airline on
   * the same site from the same IP, which on 2026-08-24 came back BLOCKED for both.
   */
  private async supersedeLiveBatchesOfRoutine(routineId: string): Promise<void> {
    const live = await this.batchRepo.findLiveForRoutine(routineId)
    for (const batch of live) {
      await this.batchRepo.markClosing(batch.id, 'superseded: nova analise pedida para a rota')
      const delivery = await this.cancelDispatcher.requestBatchCancel(batch.id, 'drain')
      log.info({ batchId: batch.id, airline: batch.airline, delivery }, 'batch superseded: aguardando o worker encerrar')
    }
  }

  private async batchSizeForRoutine(routineId: string): Promise<number> {
    const sizes = await this.airlinesRepo.batchSizesForRoutine(routineId)
    // The claim picks the route (and therefore the airline) only after this number is
    // chosen, so the safe pick is the smallest among the routine's airlines: an
    // oversized batch would blow the session budget of the airline that gets claimed.
    return sizes.length ? Math.min(...sizes) : 1
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
    // Nobody on the other end of the hub: dispatching now produces a job with no
    // heartbeat, which the lease reclaims 60s later and dispatches again, while the
    // scraper still holds the first copy in its queue. With batches the blast radius
    // is a whole batch, so this guard matters more, not less.
    if (this.env.REALTIME_ENABLED !== 'false' && !this.cancelDispatcher.hasWorkers()) {
      log.warn('dispatch paused: nenhum worker conectado ao hub')
      return
    }

    const cap = this.env.SCRAPE_MAX_IN_FLIGHT
    const perAirline = this.env.SCRAPE_MAX_IN_FLIGHT_PER_AIRLINE
    // Counts BATCHES, not items: a batch of eight would blow an item-based ceiling on
    // the very dispatch that had just been allowed.
    let inFlight = await this.batchRepo.countLive()
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
        const naCompanhia = await this.batchRepo.countLiveByAirline(airline)
        if (naCompanhia >= perAirline) {
          log.info({ airline, naCompanhia, perAirline }, 'dispatch skipped: per-airline cap reached')
          break
        }
        const result = await this.dispatchNextBatch(airline)
        if (result === 'dispatched') inFlight++
        else if (result === 'busy') {
          log.warn('dispatch paused: scraper queue full (503)')
          return
        } else break // 'empty' ou 'error': sem mais jobs/airline travada
      }
    }
  }

  private async dispatchNextBatch(airline: string): Promise<'dispatched' | 'empty' | 'busy' | 'error'> {
    const size = (await this.airlinesRepo.findByCode(airline))?.batch_size ?? 1
    const claimed = await this.batchRepo.claimBatch(airline, size)
    if (!claimed) return 'empty'
    return this.dispatchBatch(claimed)
  }

  /**
   * Sends one batch to the scraper and opens an analysis_run per item.
   *
   * A batch of ONE item is byte for byte the previous behaviour — same per-item
   * payload, same callback, same scheduling. That is what lets `airlines.batch_size`
   * default to 1 and the whole ecosystem migrate onto this path before any airline
   * actually collects more than one item per session.
   */
  private async dispatchBatch(claimed: ClaimedBatch): Promise<'dispatched' | 'busy' | 'error'> {
    const { batch, items } = claimed

    const [originCountry, destinationCountry] = await Promise.all([
      this.airportsRepo.getCountryCode(batch.origin),
      this.airportsRepo.getCountryCode(batch.destination),
    ])

    const prepared = items.map((job) => ({
      job,
      requestId:  randomUUID(),
      flightDate: toIsoDate(job.flight_date),
      returnDate: job.return_date == null ? null : toIsoDate(job.return_date),
    }))

    const payload = {
      batchId:     batch.id,
      airline:     batch.airline,
      origin:      batch.origin,
      destination: batch.destination,
      passengers:  1,
      originCountry:      originCountry ?? undefined,
      destinationCountry: destinationCountry ?? undefined,
      deadlineMs:  this.env.SCRAPE_BATCH_DEADLINE_MS,
      items: prepared.map((p) => ({
        requestId:    p.requestId,
        jobId:        p.job.id,
        outboundDate: p.flightDate,
        returnDate:   p.returnDate ?? undefined,
      })),
    }

    try {
      await this.scraperClient.dispatchBatch(payload)
    } catch (err) {
      // Queue full: holds every item (pending) with no penalty and stops the dispatch.
      // The batch is closed so its items go back to the pool — leaving it live would
      // lock the whole route out of the claim predicate.
      if (err instanceof ScraperBusyError) {
        await this.releaseBatchWithoutPenalty(
          batch.id, new Date(Date.now() + err.retryAfterMs), 'scraper queue full (503)',
        )
        log.info({ batchId: batch.id, retryAfterMs: err.retryAfterMs }, 'dispatch deferred: scraper queue full')
        return 'busy'
      }

      // Real dispatch failure: the batch never reached the worker, so the penalty is
      // recorded per item exactly as the single-job path used to do.
      this.recordFailure(batch.airline)
      await this.batchRepo.close(batch.id, 'aborted', `falha no despacho: ${String(err)}`)
      for (const p of prepared) {
        await this.analysisRunsRepo.insertRunning({
          jobId: p.job.id, requestId: p.requestId, batchId: batch.id,
          airline: batch.airline, origin: batch.origin, destination: batch.destination,
          flightDate: p.flightDate, returnDate: p.returnDate,
        })
        if (p.job.retry_count + 1 >= p.job.max_retries) {
          await this.scrapingJobRepo.markDead(p.job.id, String(err))
          await this.analysisRunsRepo.markFinished(p.requestId, { status: 'dead', errorMessage: String(err) })
        } else {
          await this.scrapingJobRepo.markFailed(p.job.id, String(err), calcBackoffNextRunAt(p.job.retry_count))
          await this.analysisRunsRepo.markFinished(p.requestId, { status: 'failed', errorMessage: String(err) })
        }
      }
      log.error({ batchId: batch.id, airline: batch.airline, err }, 'scraping_batch_dispatch_failed')
      return 'error'
    }

    // 202 accepted: only now do the items "exist" for the scraper.
    for (const p of prepared) {
      await this.scrapingJobRepo.markRunning(p.job.id, p.requestId)
      await this.analysisRunsRepo.insertRunning({
        jobId: p.job.id, requestId: p.requestId, batchId: batch.id,
        airline: batch.airline, origin: batch.origin, destination: batch.destination,
        flightDate: p.flightDate, returnDate: p.returnDate,
      })
    }
    this.recordSuccess(batch.airline)
    log.info({
      batchId: batch.id, airline: batch.airline, origin: batch.origin,
      destination: batch.destination, items: prepared.length,
    }, 'scraping_batch_dispatched')
    return 'dispatched'
  }

  /** Gives a batch back with no blame on its items: not their fault, no retry counted. */
  private async releaseBatchWithoutPenalty(batchId: string, nextRunAt: Date, reason: string): Promise<void> {
    const items = await this.batchRepo.listItems(batchId)
    await this.batchRepo.close(batchId, 'aborted', reason)
    for (const job of items) await this.scrapingJobRepo.deferJob(job.id, nextRunAt)
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

    await this.expireStaleBatches()

    const staleRuns = await this.analysisRunsRepo.failStaleRunning(STALE_RUN_TIMEOUT_MIN)
    if (staleRuns > 0) log.info({ staleRuns }, 'heartbeat: stale analysis_runs failed')
  }

  /**
   * The third and last closing door of a batch.
   *
   * The first two are the worker's explicit signal and the per-item count. Both need
   * the worker to be alive; this one does not, and it is what keeps a route from being
   * locked out of the claim predicate forever when the worker dies mid-batch.
   *
   * Items that never reported are given back with NO penalty: the lease reclaim above
   * has already put them back to 'pending', and a worker that vanished is not the
   * item's fault.
   */
  private async expireStaleBatches(): Promise<void> {
    const stale = await this.batchRepo.findLiveOlderThan(MAX_BATCH_RUN_MIN)
    for (const batch of stale) {
      const items = await this.batchRepo.listItems(batch.id)
      await this.batchRepo.close(batch.id, 'expired', `lote sem fechamento apos ${MAX_BATCH_RUN_MIN}min`)
      for (const job of items) {
        if (job.status === 'running') continue // o reclaim de lease ja cuidou
        await this.scrapingJobRepo.deferJob(job.id, calcBackoffNextRunAt(batch.attempt - 1))
      }
      log.warn({ batchId: batch.id, airline: batch.airline, items: items.length }, 'scraping_batch_expired')
    }
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
