import { FastifyInstance, FastifyReply } from 'fastify'
import { hubBus, type TelemetryEvent } from './hubBus'
import { envelope } from './protocol'
import { env } from '../config/env'
import { toDateStr } from '../services/evaluation/EvaluationService'
import type { IScrapingJobRepository, ScrapingJobRow } from '../modules/scraping-jobs/interfaces/IScrapingJobRepository'

/**
 * Hub SSE → painel Admin. Fan-out em memória dos eventos do hubBus para todos os
 * admins conectados (features.md §3b, §18). Suficiente na escala atual; quando
 * houver flight.API horizontal, troca-se este fan-out por Redis pub/sub.
 *
 * Auth: o EventSource não envia header Authorization, então o JWT vem por query
 * param (?token=) e é verificado manualmente.
 */

const HEARTBEAT_MS = 25_000
const RING_SIZE = 500

interface JobView {
  requestId: string | null
  jobId: string
  airline: string
  origin: string
  destination: string
  flightDate: string
  status: string
  runningSince: string | null
  lastStep?: string
  lastError: string | null
}

interface Client {
  reply: FastifyReply
}

const clients = new Set<Client>()
const ring: { id: number; event: string; data: string }[] = []
let globalId = 0

// Estado vivo consolidado por requestId (alimentado pela telemetria).
const liveJobs = new Map<string, JobView>()

function mapRow(j: ScrapingJobRow): JobView {
  return {
    requestId: j.request_id,
    jobId: j.id,
    airline: j.airline,
    origin: j.origin,
    destination: j.destination,
    flightDate: toDateStr(j.flight_date),
    status: j.status,
    runningSince: j.running_since ? new Date(j.running_since).toISOString() : null,
    lastError: j.last_error,
  }
}

function writeEvent(client: Client, id: number, event: string, data: string): void {
  const raw = client.reply.raw
  if (raw.writableEnded) return
  // Backpressure: se o buffer está cheio, descarta job.event (log) preservando
  // job.upsert (estado) — estado nunca se perde (§18.4).
  const ok = raw.write(`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`)
  if (!ok && event === 'job.event') { /* já escrito; só não insistimos em flush */ }
}

function broadcast(event: string, payload: unknown): void {
  globalId++
  const data = JSON.stringify(payload)
  ring.push({ id: globalId, event, data })
  if (ring.length > RING_SIZE) ring.shift()
  for (const c of clients) writeEvent(c, globalId, event, data)
}

// ── Consolidação da telemetria em JobView + timeline ──────────────────────────
hubBus.on('telemetry', (ev: TelemetryEvent) => {
  const msg = ev.message
  if (!msg.requestId) return
  const p = msg.payload

  const prev = liveJobs.get(msg.requestId)
  const view: JobView = prev ?? {
    requestId: msg.requestId,
    jobId: (p.jobId as string) ?? '',
    airline: (p.airline as string) ?? '',
    origin: (p.origin as string) ?? '',
    destination: (p.destination as string) ?? '',
    flightDate: (p.flightDate as string) ?? '',
    status: 'running',
    runningSince: (p.startedAt as string) ?? new Date().toISOString(),
    lastError: null,
  }

  switch (msg.type) {
    case 'job.started':
      view.status = 'running'
      view.airline = (p.airline as string) ?? view.airline
      view.origin = (p.origin as string) ?? view.origin
      view.destination = (p.destination as string) ?? view.destination
      view.flightDate = (p.flightDate as string) ?? view.flightDate
      view.runningSince = (p.startedAt as string) ?? view.runningSince
      break
    case 'job.progress':
      view.lastStep = p.step as string
      break
    case 'job.finished':
      view.status = (p.status as string) ?? view.status
      if (p.error) view.lastError = p.error as string
      break
  }
  liveJobs.set(msg.requestId, view)

  // Delta de estado + linha de timeline.
  broadcast('job.upsert', view)
  broadcast('job.event', {
    requestId: msg.requestId,
    seq: msg.seq ?? 0,
    ts: msg.ts,
    type: msg.type.replace('job.', ''),
    level: (p.level as string) ?? undefined,
    detail: (p.detail as string) ?? (p.step as string) ?? (p.msg as string) ?? undefined,
  })

  if (msg.type === 'job.finished') {
    // Mantém por um tempo curto para o front refletir o estado final, depois some.
    setTimeout(() => {
      liveJobs.delete(msg.requestId!)
      broadcast('job.removed', { requestId: msg.requestId })
    }, 60_000)
  }
})

export interface SseDeps {
  scrapingJobRepo: IScrapingJobRepository
}

export function sseAdminRoute(deps: SseDeps) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.get('/stream', async (req, reply) => {
      // Auth manual via query param (?token=) — EventSource não manda header.
      const token = (req.query as { token?: string }).token
      try {
        const payload = app.jwt.verify<{ role: string }>(token ?? '')
        if (payload.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
      } catch {
        return reply.code(401).send({ error: 'unauthorized' })
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // impede buffering do nginx que quebra SSE
        'Access-Control-Allow-Origin': env.FRONTEND_URL,
      })

      const client: Client = { reply }
      clients.add(client)

      // 1º evento: snapshot autoritativo (DB) + estado vivo em memória.
      const rows = await deps.scrapingJobRepo.listForAdmin()
      const snapshot = rows.map(mapRow)
      for (const v of liveJobs.values()) {
        if (!snapshot.some((s) => s.requestId && s.requestId === v.requestId)) snapshot.push(v)
      }
      reply.raw.write(`event: job.snapshot\ndata: ${JSON.stringify({ jobs: snapshot })}\n\n`)

      // Replay de eventos perdidos via Last-Event-ID (reconexão sem buracos).
      const lastId = Number(req.headers['last-event-id'])
      if (Number.isFinite(lastId)) {
        for (const e of ring) {
          if (e.id > lastId) reply.raw.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${e.data}\n\n`)
        }
      }

      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n')
      }, HEARTBEAT_MS)

      req.raw.on('close', () => {
        clearInterval(heartbeat)
        clients.delete(client)
      })
    })
  }
}

/** Nº de admins conectados — usado em testes/diagnóstico. */
export function sseClientCount(): number {
  return clients.size
}
