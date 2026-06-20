import type { IScrapingJobRepository, ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import type { IAnalysisRunsRepository, AnalysisRunEventRow } from '../analysis-runs/interfaces/IAnalysisRunsRepository'
import { requestCancel } from '../../realtime/workerGateway'

export interface CancelJobResult {
  accepted: boolean
  /** 'dispatched' = comando entregue ao worker; 'queued' = worker offline, intenção persistida. */
  delivery: 'dispatched' | 'queued'
}

export interface IAdminService {
  listJobs(): Promise<ScrapingJobRow[]>
  getJobEvents(requestId: string): Promise<AnalysisRunEventRow[]>
  cancelJob(requestId: string, userId: string): Promise<CancelJobResult>
}

export class AdminService implements IAdminService {
  constructor(
    private readonly scrapingJobRepo: IScrapingJobRepository,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
  ) {}

  listJobs(): Promise<ScrapingJobRow[]> {
    return this.scrapingJobRepo.listForAdmin()
  }

  getJobEvents(requestId: string): Promise<AnalysisRunEventRow[]> {
    return this.analysisRunsRepo.listEvents(requestId)
  }

  async cancelJob(requestId: string, userId: string): Promise<CancelJobResult> {
    // Registra a intenção + auditoria ANTES de despachar: se o worker estiver
    // offline, a intenção fica persistida (cancel_requested_at) para entrega na
    // reconexão; a confirmação real (status cancelled) chega via telemetria.
    await this.scrapingJobRepo.setCancelRequested(requestId)
    await this.analysisRunsRepo.setCancelledBy(requestId, userId)

    const dispatch = await requestCancel(requestId)
    return {
      accepted: true,
      delivery: dispatch.delivery === 'no_worker' ? 'queued' : 'dispatched',
    }
  }
}
