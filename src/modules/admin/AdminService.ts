import type { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import type { IAnalysisRunsRepository, AnalysisRunEventRow } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import type { ICancelDispatcher } from '../../realtime/workerGateway'
import { calcNextRunAt } from '../../services/scheduler/SchedulerService'

export interface CancelJobResult {
  accepted: boolean
  delivery: 'dispatched' | 'recovered'
}

export interface IAdminService {
  listJobs(): Promise<ScrapingJobRow[]>
  getJobEvents(requestId: string): Promise<AnalysisRunEventRow[]>
  getJobTimeline(jobId: string): Promise<AnalysisRunEventRow[]>
  cancelJob(requestId: string, userId: string): Promise<CancelJobResult>
}

export class AdminService implements IAdminService {
  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
    private readonly cancelDispatcher: ICancelDispatcher,
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
}
