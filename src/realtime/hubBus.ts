import { EventEmitter } from 'node:events'
import type { AnyMessage, JobStateSnapshot } from './protocol'

export interface TelemetryEvent {
  workerId: string
  message: AnyMessage
}

export interface SnapshotEvent {
  workerId: string
  jobs: JobStateSnapshot[]
}

export interface WorkerStatusEvent {
  workerId: string
  online: boolean
}

export interface HeartbeatEvent {
  workerId: string
  activeRequestIds: string[]
}

export class HubBus {
  private readonly emitter = new EventEmitter()

  publishTelemetry(ev: TelemetryEvent): void {
    this.emitter.emit('telemetry', ev)
  }

  publishSnapshot(ev: SnapshotEvent): void {
    this.emitter.emit('snapshot', ev)
  }

  publishWorkerStatus(workerId: string, online: boolean): void {
    const ev: WorkerStatusEvent = { workerId, online }
    this.emitter.emit('worker', ev)
  }

  publishHeartbeat(ev: HeartbeatEvent): void {
    this.emitter.emit('heartbeat', ev)
  }

  onTelemetry(listener: (ev: TelemetryEvent) => void): void {
    this.emitter.on('telemetry', listener)
  }

  onSnapshot(listener: (ev: SnapshotEvent) => void): void {
    this.emitter.on('snapshot', listener)
  }

  onWorker(listener: (ev: WorkerStatusEvent) => void): void {
    this.emitter.on('worker', listener)
  }

  onHeartbeat(listener: (ev: HeartbeatEvent) => void): void {
    this.emitter.on('heartbeat', listener)
  }
}
