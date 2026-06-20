import { hubBus, type TelemetryEvent } from './hubBus'
import { calcNextRunAt } from '../services/scheduler/SchedulerService'
import { logger } from '../utils/logger'
import type {
  IAnalysisRunsRepository,
  AnalysisRunEventType,
  AnalysisRunEventLevel,
} from '../modules/analysis-runs/interfaces/IAnalysisRunsRepository'
import type { IScrapingJobRepository } from '../modules/scraping-jobs/interfaces/IScrapingJobRepository'

/**
 * Consome a telemetria do hubBus e persiste:
 *   • todo evento job.* → analysis_run_events (timeline, idempotente por seq)
 *   • job.finished 'cancelled' → marca analysis_runs cancelled + libera o job
 *     (o webhook NÃO chega em cancel, então a telemetria é a única fonte).
 *
 * success/failed/blocked continuam sendo donos do webhook (ScrapeService) — aqui
 * só adicionamos a timeline, sem duplicar a transição de status.
 */

const TYPE_MAP: Record<string, AnalysisRunEventType> = {
  'job.queued': 'queued',
  'job.started': 'started',
  'job.progress': 'progress',
  'job.log': 'log',
  'job.finished': 'finished',
}

export interface RealtimePersistenceDeps {
  analysisRunsRepo: IAnalysisRunsRepository
  scrapingJobRepo: IScrapingJobRepository
}

export function startRealtimePersistence(deps: RealtimePersistenceDeps): void {
  hubBus.on('telemetry', (ev: TelemetryEvent) => {
    void persist(ev, deps)
  })
}

async function persist(ev: TelemetryEvent, deps: RealtimePersistenceDeps): Promise<void> {
  const msg = ev.message
  const type = TYPE_MAP[msg.type]
  if (!type || !msg.requestId) return

  try {
    await deps.analysisRunsRepo.appendEvent({
      requestId: msg.requestId,
      seq: msg.seq ?? 0,
      type,
      level: (msg.payload.level as AnalysisRunEventLevel | undefined) ?? null,
      payload: msg.payload,
    })

    if (type === 'finished' && msg.payload.status === 'cancelled') {
      const job = await deps.scrapingJobRepo.findByRequestId(msg.requestId)
      await deps.analysisRunsRepo.markCancelled(msg.requestId)
      if (job) {
        await deps.scrapingJobRepo.releaseCancelled(msg.requestId, calcNextRunAt(job.flight_date))
      }
      logger.info({ requestId: msg.requestId }, 'Realtime: cancelamento persistido')
    }
  } catch (err) {
    logger.warn({ err, requestId: msg.requestId }, 'Realtime: falha ao persistir telemetria')
  }
}
