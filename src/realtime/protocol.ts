/**
 * Realtime protocol (worker ↔ hub). Synchronised copy of the canonical contract
 * in flight-monitoring.IA/contracts/realtime-protocol.ts (§14).
 */
export const PROTOCOL_VERSION = 1 as const

export type RunStatus = 'running' | 'success' | 'failed' | 'dead' | 'blocked' | 'cancelled'
export type JobPhase = 'queued' | 'running' | 'finishing'
export type ScrapeStep = 'navigate' | 'fill_form' | 'search' | 'parse' | 'calendar' | 'cooldown'
export type LogLevel = 'info' | 'warn' | 'error'
export type CancelResult = 'aborted' | 'queued_removed' | 'not_found'

export interface AnyMessage {
  v: number
  type: string
  id: string
  ts: string
  requestId?: string
  seq?: number
  payload: Record<string, unknown>
}

export interface JobStateSnapshot {
  requestId: string
  phase: JobPhase
  airline: string
  origin: string
  destination: string
  flightDate: string
  startedAt: string
}

let counter = 0
export function newId(): string {
  return `${Date.now().toString(36)}-${(counter++).toString(36)}`
}

export function envelope(
  type: string,
  payload: Record<string, unknown>,
  opts: { requestId?: string; seq?: number } = {},
): AnyMessage {
  return { v: PROTOCOL_VERSION, type, id: newId(), ts: new Date().toISOString(), payload, ...opts }
}
