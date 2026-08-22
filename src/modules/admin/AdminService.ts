import type { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import type { IAnalysisRunsRepository, AnalysisRunEventRow } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import type { ITargetAlertStateRepository } from '../target-alert-state/interfaces/ITargetAlertStateRepository'
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

/** O que o reenvio fez: qual e-mail saiu, ou por que não saiu nenhum. */
export interface ResendResult {
  /** Tipo do último e-mail enviado para a rotina — é o que foi reenviado. */
  type: 'alert' | 'scheduled'
  sent: boolean
  /** Preenchido quando `sent` é false: o que faltou. */
  reason?: string
  lastSentAt: Date
}

/** Saldo do reset, linha a linha: o que zerou e o que foi preservado. */
export interface ResetAnalysesResult {
  analysisRuns: { deleted: number; events: number; keptRunning: number; keptShared: number }
  scrapingJobs: { reset: number; keptRunning: number; keptShared: number }
  alertWatermarks: { deleted: number }
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

    return {
      analysisRuns:    { deleted: runs.runs, events: runs.events, keptRunning: runs.running, keptShared: runs.shared },
      scrapingJobs:    { reset: jobs.reset, keptRunning: jobs.running, keptShared: jobs.shared },
      alertWatermarks: { deleted: watermarks },
    }
  }
}