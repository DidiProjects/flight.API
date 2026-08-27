import { IScrapeService } from './interfaces/IScrapeService'
import { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import { IAnalysisRunsRepository } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import { IFareHistoryRepository } from '../fare-history/interfaces/IFareHistoryRepository'
import { ScrapeCallback } from './schema'
import { calcNextRunAt, calcBackoffNextRunAt, calcSiteErrorNextRunAt } from '../../services/scheduler/SchedulerService'
import { IFxRateService } from '../../services/fx/interfaces/IFxRateService'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scrape' })

// An IP/bot block affects the whole airline. Pause every job of that airline for
// this long instead of retrying job-by-job (which only prolongs the block).
const BLOCK_COOLDOWN_MS = 60 * 60 * 1000

/**
 * Fallback for a callback with no `outcome` (an older scraper, or a failure
 * with no screen to classify).
 *
 * It used to be the primary source, and it is a trap: it matched the word
 * "block" that the scraper itself wrote into the error text when guessing a
 * block. The message proved itself, and LATAM was paused for an hour, three
 * times on 2026-08-20, over an error page of its own site.
 */
function isBlockError(error: string): boolean {
  return /bot|block|ip[\s/_-]?block|captcha|detection|acesso foi limitado|comportamento incomum/i.test(error)
}

/** A block pauses the whole airline: the evidence must come from the DOM, not the text. */
function isAirlineBlocked(data: ScrapeCallback): boolean {
  if (data.outcome) return data.outcome.state === 'BLOCKED'
  return isBlockError(data.error ?? '')
}

/**
 * The airline declared a failure of its own (its search did not respond, or it
 * showed its own error page). Not a block — it pauses nobody — and not the
 * job's fault, so it does not escalate to 'dead'.
 */
function isSiteError(data: ScrapeCallback): boolean {
  return data.outcome?.state === 'SITE_ERROR'
}

/** A pg DATE comes back as string or Date; normalise to YYYY-MM-DD or null. */
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
    private readonly fareHistoryRepo: IFareHistoryRepository,
  ) {}

  /**
   * Feeds the curated history from the fares just written.
   *
   * Never blocks the callback: the collection is already persisted and the job
   * already rescheduled, so losing a history point is worth far less than
   * failing the run over it.
   */
  private async recordHistory(requestId: string, jobId: string): Promise<void> {
    try {
      const segments = await this.fareHistoryRepo.recordRun(requestId)
      log.info({ jobId, requestId, segments }, 'fare history recorded')
    } catch (err) {
      log.error({ err, jobId, requestId }, 'fare history failed: collection kept')
    }
  }

  /**
   * Converts the fares to Real ONCE, here, when the analysis is ingested.
   *
   * The rate is stored on the row: history then reflects the exchange rate of
   * when the routine ran, not of today. Conversion used to happen on read, and
   * the 30-day baseline moved on its own — a falling pound became "the flight
   * got cheaper".
   *
   * One quote per CURRENCY, not per row: the FxRateService cache is keyed by
   * currency-day, so the 40 fares of a collection cost one lookup.
   *
   * Without a quote the row goes in with `null` instead of being rejected. Losing
   * the price because the exchange rate blinked would be worse than storing it
   * without the Real value — the currency is still there, and Real sums skip the row.
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
      await this.applyFailurePolicy(data, job, { orphan: false })
      return
    }

    const rows  = await this.withBrl(this.toFareRows(data, toDateOrNull(job.return_date)), { requestId: data.requestId, airline: data.airline })
    const count = await this.flightFaresRepo.insertMany(job.id, data.requestId, rows)
    await this.recordHistory(data.requestId, job.id)

    const nextRunAt = calcNextRunAt(job.flight_date)
    await this.scrapingJobRepo.markSuccess(job.id, nextRunAt)
    await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })

    log.info({ jobId: job.id, faresCount: count }, 'scraping_job_success')
  }

  /**
   * What a failed collection does to the job that produced it.
   *
   * Shared with the orphan path on purpose. It used to live only here, and an orphan
   * error callback closed the `analysis_run` and returned — so the reaction the failure
   * called for never happened. On 2026-08-27 that turned a blocked Azul into a loop: the
   * cooldown that pauses the airline is applied HERE, the callback always arrived
   * orphaned, and the next cycle asked the same blocked site again.
   */
  private async applyFailurePolicy(
    data: ScrapeCallback,
    job: ScrapingJobRow | null,
    { orphan }: { orphan: boolean },
  ): Promise<void> {
    const error = data.error ?? 'falha sem mensagem'

    // IP/bot block: pause the whole airline for a cooldown. Do NOT escalate to
    // dead — the block is not the job's fault.
    //
    // The pause is by AIRLINE, so it does not depend on identifying the job: an orphan
    // block is the same block, and the airline is in the payload.
    if (isAirlineBlocked(data)) {
      const until = new Date(Date.now() + BLOCK_COOLDOWN_MS)
      const paused = await this.scrapingJobRepo.pauseAirlineForBlock(data.airline, until, error)
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'blocked', errorMessage: error })
      log.warn({ jobId: job?.id, airline: data.airline, paused, until, orphan, evidence: data.outcome?.evidence }, 'scraping_airline_blocked: airline paused')
      return
    }

    // From here on the reaction is job-scoped (retry counter, next_run_at), so it needs
    // a job that is still the one this run belongs to. A job already re-dispatched under
    // another request_id must not have its state overwritten by the previous corrida.
    const jobMovedOn = job != null && job.status === 'running' && job.request_id !== data.requestId
    if (!job || jobMovedOn) {
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'failed', errorMessage: error })
      log.warn({ requestId: data.requestId, jobId: job?.id, jobMovedOn }, 'orphan callback (erro): run fechada, job seguiu em outra corrida')
      return
    }

    // Site failure: only this job waits, and it waits longer than on an ordinary
    // failure — hammering a search that does not respond every minute does not
    // make it respond.
    if (isSiteError(data)) {
      const nextRunAt = calcSiteErrorNextRunAt(job.retry_count)
      await this.scrapingJobRepo.markSiteError(job.id, error, nextRunAt)
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'failed', errorMessage: error })
      log.warn({ jobId: job.id, airline: job.airline, nextRunAt, orphan, reason: data.outcome?.reason }, 'scraping_job_site_error')
      return
    }

    const nextRunAt = calcBackoffNextRunAt(job.retry_count)
    if (job.retry_count + 1 >= job.max_retries) {
      await this.scrapingJobRepo.markDead(job.id, error)
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'dead', errorMessage: error })
      log.error({ jobId: job.id, orphan, error }, 'scraping_job_dead')
    } else {
      await this.scrapingJobRepo.markFailed(job.id, error, nextRunAt)
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'failed', errorMessage: error })
      log.warn({ jobId: job.id, orphan, retryCount: job.retry_count + 1 }, 'scraping_job_failed')
    }
  }

  // A callback whose request_id matches no job: the job was already recovered
  // (timeout) and re-dispatched, or this is a duplicate/late delivery. The
  // payload carries the scraping_job id in `routineId`, so we try to rehydrate
  // from it, to lose neither the collection nor the analysis_run stuck in running.
  private async handleOrphanCallback(data: ScrapeCallback): Promise<void> {
    const job = data.routineId
      ? await this.scrapingJobRepo.findById(data.routineId)
      : null

    // Error with no flights: same policy as an identified callback. It is orphan in the
    // bookkeeping, not in what it says about the airline and about the job.
    if (data.error && data.flights.length === 0) {
      await this.applyFailurePolicy(data, job, { orphan: true })
      return
    }

    if (!job) {
      // With no job there is no scraping_job_id to tie the fares to — close the run.
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })
      log.warn({ requestId: data.requestId }, 'orphan callback: job não encontrado, fares descartadas')
      return
    }

    // Persists the collection (ON CONFLICT protects against a duplicate in the same run).
    const rows  = await this.withBrl(this.toFareRows(data, toDateOrNull(job.return_date)), { requestId: data.requestId, airline: data.airline })
    const count = await this.flightFaresRepo.insertMany(job.id, data.requestId, rows)
    await this.recordHistory(data.requestId, job.id)

    // Only reschedules the job if it is NOT mid-collection (a re-dispatch already in
    // flight with another request_id) — in that case we avoid overwriting the state.
    const jobMovedOn = job.status === 'running' && job.request_id !== data.requestId
    if (!jobMovedOn) {
      await this.scrapingJobRepo.markSuccess(job.id, calcNextRunAt(job.flight_date))
    }
    await this.analysisRunsRepo.markFinished(data.requestId, { status: 'success', faresFound: data.flights.length })

    log.info({ jobId: job.id, faresCount: count, jobMovedOn }, 'orphan callback: coleta salva')
  }

  /**
   * `return_date` comes from the JOB, not from the callback: the job defines the
   * pair that was searched. Without this stamp a fare collected in a round-trip
   * search would be indistinguishable from a loose one and reused as if it were.
   */
  private toFareRows(data: ScrapeCallback, returnDate: string | null) {
    // A fare with no currency does not enter. `scraping.API` already discards at
    // the source, but the guarantee has to exist on this side too: the column is
    // NOT NULL and the INSERT is ONE multi-row command — a single bad offer would
    // abort the whole batch and the entire collection would be lost over one row.
    //
    // Filtering instead of rejecting the callback is deliberate: the error belongs
    // to whoever collected, and losing 1 offer beats losing the 44 of the same search.
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

    // A return with the SAME route as the search is the outbound list read as if it
    // were the return list — the pair would close the outbound with itself and sum
    // two legs in the same direction. The scraper already cuts at the source; this
    // is the net, because bad data is indistinguishable from good once stored.
    //
    // The criterion is a route EQUAL to the outbound, not exactly inverted: BA
    // returns 21 LCY→GRU inbounds on a GRU→LHR search, and demanding the exact
    // inverse would discard legitimate returns from any multi-airport airline.
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
      // `|| null`, not `?? null`: the scraper uses an empty string for "could not
      // read the flight number", and it passed straight through. The dedup unique
      // index only excludes NULL (`WHERE flight_number IS NOT NULL`), so two failed
      // reads in the same collection collided on the key and the second was
      // silently discarded — losing a real fare for not knowing its number.
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
      // 1-to-N link: only the returns carry the outbound that priced them.
      paired_outbound_flight: f.isReturn ? (f.pairedOutboundFlight ?? null) : null,
      // An undefined return is a property of the OUTBOUND (ITS returns did not open).
      inbound_unavailable:    !f.isReturn && f.inboundUnavailable === true,
    }))
  }
}
