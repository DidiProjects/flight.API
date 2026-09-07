import { IScrapeService } from './interfaces/IScrapeService'
import { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import { IAnalysisRunsRepository } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import { IScrapingBatchRepository, ScrapingBatchRow } from '../scraping-batches/interfaces/IScrapingBatchRepository'
import { IFareHistoryRepository } from '../fare-history/interfaces/IFareHistoryRepository'
import { BatchCallback, ScrapeCallback } from './schema'
import { calcNextRunAt, calcBackoffNextRunAt, calcSiteErrorNextRunAt } from '../../services/scheduler/SchedulerService'
import { IFxRateService } from '../../services/fx/interfaces/IFxRateService'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scrape' })

// An IP/bot block affects the whole airline. Pause every job of that airline for
// this long instead of retrying job-by-job (which only prolongs the block).
const BLOCK_COOLDOWN_MS = 60 * 60 * 1000

// Janela para os últimos callbacks de item chegarem depois do sinal de fechamento do
// worker. Curta de propósito: o caminho normal é o fechamento vir DEPOIS do último
// callback, pelo mesmo canal HTTP e na mesma sequência, então esta espera só existe
// para o callback que se perdeu — e `ResultSender` engole falha de entrega, o que faz
// disso um caso real e não hipotético.
const BATCH_DRAIN_MS = 30_000

const LIVE_BATCH = ['dispatched', 'running', 'closing']

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
 * States that describe a collection that did NOT happen, even with no `error`.
 *
 * A block does not raise an exception — it paints a screen — so the scraper reports it
 * in `outcome` and sends no `error`. While the failure gate asked only for `error`, a
 * BLOCKED callback walked straight into `markSuccess`: the airline was never paused,
 * `next_run_at` was pushed forward and the run was filed as a collection with zero
 * fares. Measured on 2026-08-29: 3 of 7 runs of the same GRU→LHR pair.
 *
 * `EMPTY` is deliberately out. It is the airline saying there is no flight, and turning
 * it into a failure burns a date that will never have one through retry into `dead`.
 * The false EMPTY is fixed where it is born — the scraper now classifies the Akamai
 * screen as BLOCKED.
 */
const ESTADOS_DE_FALHA = ['BLOCKED', 'SITE_ERROR', 'LAYOUT_CHANGED'] as const

function coletaFalhou(data: ScrapeCallback): boolean {
  if (data.flights.length > 0) return false
  if (data.error) return true
  return data.outcome != null && (ESTADOS_DE_FALHA as readonly string[]).includes(data.outcome.state)
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
    private readonly batchRepo: IScrapingBatchRepository,
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

    // O item pertence a um lote que o worker ainda segura? Entao a reacao de
    // AGENDAMENTO fica suspensa ate o lote fechar. As tarifas e a analysis_run seguem
    // normalmente — o que espera e so o destino do job.
    const batch = job.batch_id ? await this.batchRepo.findById(job.batch_id) : null
    const emLoteVivo = batch != null && LIVE_BATCH.includes(batch.status)
    if (batch) await this.registerBatchProgress(batch.id)

    if (coletaFalhou(data)) {
      await this.applyFailurePolicy(data, job, { orphan: false, emLoteVivo })
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
    { orphan, emLoteVivo = false }: { orphan: boolean; emLoteVivo?: boolean },
  ): Promise<void> {
    // A failure reported only through `outcome` carries no `error` text. Falling back to
    // "falha sem mensagem" would file the state that explains it — and its evidence —
    // into nothing, on exactly the callbacks this policy now exists to catch.
    const error = data.error
      ?? (data.outcome ? `${data.outcome.state}: ${data.outcome.reason ?? 'sem motivo declarado'}` : 'falha sem mensagem')

    // IP/bot block: pause the whole airline for a cooldown. Do NOT escalate to
    // dead — the block is not the job's fault.
    //
    // The pause is by AIRLINE, so it does not depend on identifying the job: an orphan
    // block is the same block, and the airline is in the payload.
    if (isAirlineBlocked(data)) {
      const until = new Date(Date.now() + BLOCK_COOLDOWN_MS)
      // Os lotes vivos da companhia fecham JUNTO com a pausa. `pauseAirlineForBlock`
      // devolve todo job da companhia para 'pending' — inclusive os 'running' — e um
      // lote que continuasse vivo trancaria esses itens para sempre: pendentes, com
      // next_run_at vencido, e invisiveis ao claim.
      const lotes = await this.batchRepo.closeLiveByAirline(data.airline, `bloqueio: ${error}`)
      const paused = await this.scrapingJobRepo.pauseAirlineForBlock(data.airline, until, error)
      if (lotes.length) log.warn({ airline: data.airline, batches: lotes.map((b) => b.id) }, 'lotes encerrados pelo bloqueio da companhia')
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

    // Item de lote vivo: registra o erro, solta a lease e PARA. Quem decide retentativa
    // e proximo horario e o fechamento do lote, com os irmaos dele na mao. Vale
    // inclusive para SITE_ERROR: a pagina de erro da LATAM nao e bloqueio e nao pode
    // derrubar o lote — ela e mais um item que falhou.
    if (emLoteVivo) {
      await this.scrapingJobRepo.holdForBatch(job.id, error)
      await this.analysisRunsRepo.markFinished(data.requestId, { status: 'failed', errorMessage: error })
      log.warn({ jobId: job.id, batchId: job.batch_id, orphan }, 'scraping_job_failed_in_batch')
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

  /**
   * The batch came back whole — the signal the API cannot deduce on its own.
   *
   * It is what keeps a fragment of a batch from being re-dispatched: while the batch
   * is live its items are out of the claim pool entirely, and only here do they get
   * their fate decided, together.
   *
   * Idempotent: a batch already closed just logs and returns. The worker may retry
   * this delivery, and the time backstop in the scheduler may have closed it first.
   */
  async processBatchCallback(data: BatchCallback): Promise<void> {
    const batch = await this.batchRepo.findById(data.batchId)
    if (!batch) {
      log.warn({ batchId: data.batchId, airline: data.airline }, 'batch callback: lote desconhecido')
      return
    }
    if (!LIVE_BATCH.includes(batch.status)) {
      log.info({ batchId: batch.id, status: batch.status }, 'batch callback: lote já fechado')
      return
    }

    log.info({
      batchId: batch.id, airline: batch.airline, reason: data.reason,
      items: data.items.length, itemCount: batch.item_count, received: batch.received_count,
    }, 'batch callback received')

    await this.batchRepo.markClosing(batch.id, data.reason)

    // Quantos itens ainda deviam entregar callback. Item não tentado nunca teve
    // corrida, então não entra na conta — esperar por ele seguraria o lote por nada.
    const naoTentados = data.items.filter((i) => i.state === 'not_attempted').length
    const esperados = Math.max(batch.item_count - naoTentados, 0)
    const atual = await this.batchRepo.findById(batch.id)
    if (atual && atual.received_count >= esperados) {
      await this.finalizeBatch(atual, data)
      return
    }

    // Falta callback: espera a janela curta e fecha do mesmo jeito. O heartbeat é o
    // backstop caso este processo morra no meio.
    log.warn({ batchId: batch.id, esperados, recebidos: atual?.received_count }, 'batch callback: aguardando callbacks atrasados')
    setTimeout(() => {
      void this.batchRepo.findById(batch.id)
        .then((b) => (b && LIVE_BATCH.includes(b.status) ? this.finalizeBatch(b, data) : undefined))
        .catch((err) => log.error({ err, batchId: batch.id }, 'batch drain falhou'))
    }, BATCH_DRAIN_MS).unref?.()
  }

  /**
   * Decides what happens to every item the batch still holds.
   *
   * An item that succeeded has already left the batch (`markSuccess` clears
   * `batch_id`), so whatever is still attached here either failed or never ran.
   *
   * The `penalise` split is the whole point: a block, a supersede and an item that was
   * never attempted are not the item's fault, and none of them may escalate it towards
   * 'dead'. With `max_retries = 3` and a batch of eight, counting a retry on all three
   * of those would kill a whole route in three bad nights, where today one job dies
   * alone.
   */
  private async finalizeBatch(batch: ScrapingBatchRow, data: BatchCallback): Promise<void> {
    const status = data.reason === 'blocked' ? 'aborted'
      : data.reason === 'superseded' ? 'superseded'
      : data.reason === 'watchdog' ? 'aborted'
      : data.reason === 'cancelled' ? 'aborted'
      : 'completed'

    const closed = await this.batchRepo.close(batch.id, status, data.reason)
    if (!closed) return // outra corrida fechou primeiro

    const naoTentados = new Set(
      data.items.filter((i) => i.state === 'not_attempted').map((i) => i.requestId),
    )
    const erroPorRequest = new Map(
      data.items.filter((i) => i.error).map((i) => [i.requestId, i.error!]),
    )

    // Supersede: o pedido foi explícito — descartar o que sobrou e dar a vez à análise
    // nova. Sem penalidade e disponível já, porque o lote novo cobre as mesmas datas.
    const superseded = data.reason === 'superseded'
    // Bloqueio: `pauseAirlineForBlock` já empurrou tudo da companhia para depois do
    // cooldown, então aqui só é preciso soltar o item sem culpa.
    const bloqueado = data.reason === 'blocked'

    const items = await this.batchRepo.listItems(batch.id)
    let penalizados = 0
    let liberados = 0

    for (const job of items) {
      const naoTentado = job.request_id != null && naoTentados.has(job.request_id)
      const semCulpa = superseded || bloqueado || naoTentado

      if (semCulpa) {
        await this.scrapingJobRepo.settleBatchItem(job.id, {
          penalise: false,
          nextRunAt: superseded ? new Date() : calcBackoffNextRunAt(0),
          error: erroPorRequest.get(job.request_id ?? '') ?? null,
        })
        liberados++
        continue
      }

      // Backoff DE LOTE: a tentativa do lote, e não a do item, é o que cresce. É o que
      // impede a falha de um item de voltar sozinha em 60s.
      await this.scrapingJobRepo.settleBatchItem(job.id, {
        penalise: true,
        nextRunAt: calcBackoffNextRunAt(batch.attempt),
        error: erroPorRequest.get(job.request_id ?? '') ?? `lote encerrado: ${data.reason}`,
      })
      penalizados++
    }

    log.info({
      batchId: batch.id, airline: batch.airline, status, reason: data.reason,
      penalizados, liberados, attempt: batch.attempt,
    }, 'scraping_batch_closed')
  }

  /**
   * Um callback de item chegou. Se ele fecha a conta de um lote que já recebeu o sinal
   * do worker, o fechamento acontece aqui — as duas ordens de chegada funcionam.
   */
  private async registerBatchProgress(batchId: string): Promise<void> {
    const batch = await this.batchRepo.registerReceived(batchId)
    if (!batch) return
    if (batch.status === 'dispatched') await this.batchRepo.markRunning(batchId)
  }

  // A callback whose request_id matches no job: the job was already recovered
  // (timeout) and re-dispatched, or this is a duplicate/late delivery. The
  // payload carries the scraping_job id in `routineId`, so we try to rehydrate
  // from it, to lose neither the collection nor the analysis_run stuck in running.
  private async handleOrphanCallback(data: ScrapeCallback): Promise<void> {
    const job = data.routineId
      ? await this.scrapingJobRepo.findById(data.routineId)
      : null

    // Failure with no flights: same policy as an identified callback. It is orphan in the
    // bookkeeping, not in what it says about the airline and about the job.
    if (coletaFalhou(data)) {
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
