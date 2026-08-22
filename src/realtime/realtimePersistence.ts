import { HubBus, type TelemetryEvent } from './hubBus'
import { calcNextRunAt } from '../services/scheduler/SchedulerService'
import { logger } from '../utils/logger'
import type {
  IAnalysisRunsRepository,
  AnalysisRunEventType,
  AnalysisRunEventLevel,
} from '../modules/analysis-runs/interfaces/IAnalysisRunsRepository'
import type { IScrapingJobRepository } from '../modules/scraping-jobs/interfaces/IScrapingJobRepository'

const TYPE_MAP: Record<string, AnalysisRunEventType> = {
  'job.queued': 'queued',
  'job.started': 'started',
  'job.progress': 'progress',
  'job.log': 'log',
  'job.finished': 'finished',
}

export class RealtimePersistence {
  constructor(
    private readonly hubBus: HubBus,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
    private readonly scrapingJobRepo: IScrapingJobRepository,
  ) {}

  start(): void {
    this.hubBus.onTelemetry((ev) => { void this.persist(ev) })
    // Lease: the worker heartbeat and snapshot renew last_heartbeat_at of the jobs
    // it still holds (queued or running) — a live job is not reclaimed.
    this.hubBus.onHeartbeat((ev) => { void this.renewLease(ev.activeRequestIds) })
    this.hubBus.onSnapshot((ev) => { void this.renewLease(ev.jobs.map((j) => j.requestId)) })
  }

  private async renewLease(requestIds: string[]): Promise<void> {
    if (requestIds.length === 0) return
    try {
      await this.scrapingJobRepo.markHeartbeat(requestIds)
    } catch (err) {
      logger.warn({ err }, 'Realtime: falha ao renovar lease (heartbeat)')
    }
  }

  private async persist(ev: TelemetryEvent): Promise<void> {
    const msg = ev.message
    const type = TYPE_MAP[msg.type]
    if (!type || !msg.requestId) return

    try {
      await this.analysisRunsRepo.appendEvent({
        requestId: msg.requestId,
        seq: msg.seq ?? 0,
        type,
        level: (msg.payload.level as AnalysisRunEventLevel | undefined) ?? null,
        payload: msg.payload,
      })

      if (type === 'started') {
        // Real start of the scrape: the timeout clock counts from here, not from
        // dispatch — a job that waited in the queue does not count as "running".
        await this.scrapingJobRepo.markStarted(msg.requestId)
        await this.analysisRunsRepo.resetStartedAt(msg.requestId)
      }

      if (type === 'finished' && msg.payload.status === 'cancelled') {
        const job = await this.scrapingJobRepo.findByRequestId(msg.requestId)
        await this.analysisRunsRepo.markCancelled(msg.requestId)
        if (job) {
          await this.scrapingJobRepo.releaseCancelled(msg.requestId, calcNextRunAt(job.flight_date))
        }
        logger.info({ requestId: msg.requestId }, 'Realtime: cancelamento persistido')
      }
    } catch (err) {
      logger.warn({ err, requestId: msg.requestId }, 'Realtime: falha ao persistir telemetria')
    }
  }
}
