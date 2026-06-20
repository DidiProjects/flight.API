import { EventEmitter } from 'node:events'
import type { AnyMessage, JobStateSnapshot } from './protocol'

/**
 * Barramento interno do hub. O workerGateway publica aqui a telemetria recebida
 * dos workers; os consumidores (Stage 4: persistência; Stage 5: fan-out SSE)
 * assinam. Desacopla o transporte WS da persistência e do fan-out.
 */
export const hubBus = new EventEmitter()

export interface TelemetryEvent {
  workerId: string
  message: AnyMessage
}

export interface SnapshotEvent {
  workerId: string
  jobs: JobStateSnapshot[]
}

/** Telemetria de um job (job.queued|started|progress|log|finished). */
export function publishTelemetry(ev: TelemetryEvent): void {
  hubBus.emit('telemetry', ev)
}

/** Snapshot de reconciliação enviado pelo worker ao (re)conectar. */
export function publishSnapshot(ev: SnapshotEvent): void {
  hubBus.emit('snapshot', ev)
}

/** Worker conectou/desconectou — usado para marcar jobs órfãos, etc. */
export function publishWorkerStatus(workerId: string, online: boolean): void {
  hubBus.emit('worker', { workerId, online })
}
