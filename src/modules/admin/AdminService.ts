import type { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import type { IAnalysisRunsRepository, AnalysisRunEventRow } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import type { ITargetAlertStateRepository } from '../target-alert-state/interfaces/ITargetAlertStateRepository'
import type { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import type { IFareHistoryRepository } from '../fare-history/interfaces/IFareHistoryRepository'
import type { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'
import type { INotificationsService } from '../../services/notifications/interfaces/INotificationsService'
import type { INotificationLogRepository } from '../../services/notifications/interfaces/INotificationLogRepository'
import type { IEvaluationService } from '../../services/evaluation/interfaces/IEvaluationService'
import type { ICancelDispatcher } from '../../realtime/workerGateway'
import { calcNextRunAt } from '../../services/scheduler/SchedulerService'
import { NotFoundError } from '../../utils/errors'

export interface CancelJobResult {
  accepted: boolean
  delivery: 'dispatched' | 'recovered'
}

/** What the resend did: which e-mail went out, or why none did. */
export interface ResendResult {
  /** Kind of the last e-mail sent to the routine — that is what was resent. */
  type: 'alert' | 'scheduled'
  sent: boolean
  /** Filled when `sent` is false: what was missing. */
  reason?: string
  lastSentAt: Date
}

/** Balance of the reset, row by row: what was cleared and what was preserved. */
export interface ResetAnalysesResult {
  analysisRuns: { deleted: number; events: number; keptRunning: number; keptShared: number }
  scrapingJobs: { reset: number; keptRunning: number; keptShared: number }
  alertWatermarks: { deleted: number }
  /** Raw collections. The card price reads these, so a reset that spares them shows the old price. */
  fares: { deleted: number; keptShared: number }
  /** Curated series behind the chart (018). */
  priceHistory: { itineraries: number; segments: number; keptShared: number }
}

export interface IAdminService {
  listJobs(): Promise<ScrapingJobRow[]>
  getJobEvents(requestId: string): Promise<AnalysisRunEventRow[]>
  getJobTimeline(jobId: string): Promise<AnalysisRunEventRow[]>
  cancelJob(requestId: string, userId: string): Promise<CancelJobResult>
  resendLastNotification(routineId: string): Promise<ResendResult>
  resetRoutineAnalyses(routineId: string): Promise<ResetAnalysesResult>
}

export class AdminService implements IAdminService {
  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
    private readonly cancelDispatcher: ICancelDispatcher,
    private readonly routinesRepo: IRoutinesRepository,
    private readonly notifLogRepo: INotificationLogRepository,
    private readonly notifSvc: INotificationsService,
    private readonly evaluationSvc: IEvaluationService,
    private readonly alertStateRepo: ITargetAlertStateRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly fareHistoryRepo: IFareHistoryRepository,
  ) {}

  listJobs(): Promise<ScrapingJobRow[]> {
    return this.scrapingJobRepo.listForAdmin()
  }

  getJobEvents(requestId: string): Promise<AnalysisRunEventRow[]> {
    return this.analysisRunsRepo.listEvents(requestId)
  }

  getJobTimeline(jobId: string): Promise<AnalysisRunEventRow[]> {
    return this.analysisRunsRepo.listEventsByJobId(jobId)
  }

  async cancelJob(requestId: string, userId: string): Promise<CancelJobResult> {
    await this.scrapingJobRepo.setCancelRequested(requestId)
    await this.analysisRunsRepo.setCancelledBy(requestId, userId)

    const dispatch = await this.cancelDispatcher.requestCancel(requestId)
    if (dispatch.delivery === 'dispatched') {
      return { accepted: true, delivery: 'dispatched' }
    }

    const job = await this.scrapingJobRepo.findByRequestId(requestId)
    await this.analysisRunsRepo.markCancelled(requestId)
    if (job) await this.scrapingJobRepo.releaseCancelled(requestId, calcNextRunAt(job.flight_date))
    return { accepted: true, delivery: 'recovered' }
  }
  /**
   * Re-sends the routine's last e-mail — whichever kind it was. The kind comes
   * from notification_log; the content is rebuilt from the fares that are in the
   * bank now, because nothing stores the rendered message.
   */
  async resendLastNotification(routineId: string): Promise<ResendResult> {
    const routine = await this.routinesRepo.findByIdAdmin(routineId)
    if (!routine) throw new NotFoundError('Rotina não encontrada')

    const last = await this.notifLogRepo.findLastForRoutine(routineId)
    if (!last) throw new NotFoundError('Esta rotina nunca enviou e-mail')

    // 'best_of_day' is the old name of the daily summary and still exists in
    // rows from before the rename — it resends as the summary it always was.
    const type = last.type === 'alert' ? 'alert' as const : 'scheduled' as const

    const sent = type === 'alert'
      ? await this.evaluationSvc.resendAlert(routine)
      : await this.notifSvc.resendDailySummary(routine)

    return {
      type,
      sent,
      lastSentAt: last.sent_at,
      ...(sent ? {} : { reason: type === 'alert'
        ? 'Nenhuma oferta dentro do alvo com os dados atuais'
        : 'Nenhuma tarifa disponível para a rotina' }),
    }
  }

  /**
   * Wipes the routine's analysis history so it starts over. Only what this
   * routine alone reaches is touched: runs and jobs are keyed by ROUTE, so a row
   * another routine also covers is left in place and reported back as kept.
   */
  async resetRoutineAnalyses(routineId: string): Promise<ResetAnalysesResult> {
    const routine = await this.routinesRepo.findByIdAdmin(routineId)
    if (!routine) throw new NotFoundError('Rotina não encontrada')

    const runs = await this.analysisRunsRepo.deleteExclusiveToRoutine(routineId)
    const jobs = await this.scrapingJobRepo.resetExclusiveToRoutine(routineId)
    const watermarks = await this.alertStateRepo.deleteByRoutine(routineId)
    // The collections and the series they feed. Without these two the reset
    // cleared the history and the card went on showing the last price it had,
    // because /fares/current reads flight_fares and not the runs.
    const fares = await this.flightFaresRepo.deleteExclusiveToRoutine(routineId)
    const history = await this.fareHistoryRepo.deleteExclusiveToRoutine(routineId)

    return {
      analysisRuns:    { deleted: runs.runs, events: runs.events, keptRunning: runs.running, keptShared: runs.shared },
      scrapingJobs:    { reset: jobs.reset, keptRunning: jobs.running, keptShared: jobs.shared },
      alertWatermarks: { deleted: watermarks },
      fares:           { deleted: fares.deleted, keptShared: fares.shared },
      priceHistory:    { itineraries: history.itineraries, segments: history.segments, keptShared: history.shared },
    }
  }
}