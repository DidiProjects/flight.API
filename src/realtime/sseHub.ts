import { FastifyInstance, FastifyReply } from 'fastify'
import { envelope } from './protocol'
import { HubBus, type TelemetryEvent } from './hubBus'
import { env } from '../config/env'
import { toDateStr } from '../services/evaluation/EvaluationService'
import type { AdminJobRow, IScrapingJobRepository } from '../modules/scraping-jobs/interfaces/IScrapingJobRepository'

const HEARTBEAT_MS = 25_000
const RING_SIZE = 500
const JOB_RETENTION_MS = 60_000

interface JobView {
  requestId: string | null
  jobId: string
  airline: string
  origin: string
  destination: string
  flightDate: string
  status: string
  runningSince: string | null
  startedAt: string | null
  finishedAt: string | null
  lastStep?: string
  lastError: string | null
}

interface Client {
  reply: FastifyReply
}

interface RingEntry {
  id: number
  event: string
  data: string
}

function mapRow(j: AdminJobRow): JobView {
  return {
    requestId: j.request_id,
    jobId: j.id,
    airline: j.airline,
    origin: j.origin,
    destination: j.destination,
    flightDate: toDateStr(j.flight_date),
    status: j.status,
    runningSince: j.running_since ? new Date(j.running_since).toISOString() : null,
    startedAt: j.run_started_at ? new Date(j.run_started_at).toISOString() : null,
    finishedAt: j.run_finished_at ? new Date(j.run_finished_at).toISOString() : null,
    lastError: j.last_error,
  }
}

export class SseHub {
  private readonly clients = new Set<Client>()
  private readonly ring: RingEntry[] = []
  private globalId = 0
  private readonly liveJobs = new Map<string, JobView>()

  constructor(
    private readonly hubBus: HubBus,
    private readonly scrapingJobRepo: IScrapingJobRepository,
  ) {
    this.hubBus.onTelemetry((ev) => this.consume(ev))
  }

  clientCount(): number {
    return this.clients.size
  }

  readonly plugin = async (app: FastifyInstance): Promise<void> => {
    app.get('/stream', async (req, reply) => {
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
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': env.FRONTEND_URL,
      })

      const client: Client = { reply }
      this.clients.add(client)

      const rows = await this.scrapingJobRepo.listForAdmin()
      const snapshot = rows.map(mapRow)
      for (const v of this.liveJobs.values()) {
        if (!snapshot.some((s) => s.requestId && s.requestId === v.requestId)) snapshot.push(v)
      }
      reply.raw.write(`event: job.snapshot\ndata: ${JSON.stringify({ jobs: snapshot })}\n\n`)

      const lastId = Number(req.headers['last-event-id'])
      if (Number.isFinite(lastId)) {
        for (const e of this.ring) {
          if (e.id > lastId) reply.raw.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${e.data}\n\n`)
        }
      }

      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n')
      }, HEARTBEAT_MS)

      req.raw.on('close', () => {
        clearInterval(heartbeat)
        this.clients.delete(client)
      })
    })
  }

  private writeEvent(client: Client, id: number, event: string, data: string): void {
    const raw = client.reply.raw
    if (raw.writableEnded) return
    raw.write(`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`)
  }

  private broadcast(event: string, payload: unknown): void {
    this.globalId++
    const data = JSON.stringify(payload)
    this.ring.push({ id: this.globalId, event, data })
    if (this.ring.length > RING_SIZE) this.ring.shift()
    for (const c of this.clients) this.writeEvent(c, this.globalId, event, data)
  }

  private consume(ev: TelemetryEvent): void {
    const msg = ev.message
    if (!msg.requestId) return
    const p = msg.payload

    const prev = this.liveJobs.get(msg.requestId)
    const view: JobView = prev ?? {
      requestId: msg.requestId,
      jobId: (p.jobId as string) ?? '',
      airline: (p.airline as string) ?? '',
      origin: (p.origin as string) ?? '',
      destination: (p.destination as string) ?? '',
      flightDate: (p.flightDate as string) ?? '',
      status: 'running',
      runningSince: (p.startedAt as string) ?? new Date().toISOString(),
      startedAt: (p.startedAt as string) ?? new Date().toISOString(),
      finishedAt: null,
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
        view.startedAt = (p.startedAt as string) ?? view.startedAt
        view.finishedAt = null
        break
      case 'job.progress':
        view.lastStep = p.step as string
        break
      case 'job.finished':
        view.status = (p.status as string) ?? view.status
        view.finishedAt = new Date().toISOString()
        if (p.error) view.lastError = p.error as string
        break
    }
    this.liveJobs.set(msg.requestId, view)

    this.broadcast('job.upsert', view)
    this.broadcast('job.event', {
      requestId: msg.requestId,
      seq: msg.seq ?? 0,
      ts: msg.ts,
      type: msg.type.replace('job.', ''),
      level: (p.level as string) ?? undefined,
      detail: (p.detail as string) ?? (p.step as string) ?? (p.msg as string) ?? undefined,
    })

    if (msg.type === 'job.finished') {
      const requestId = msg.requestId
      setTimeout(() => {
        this.liveJobs.delete(requestId)
        this.broadcast('job.removed', { requestId })
      }, JOB_RETENTION_MS)
    }
  }
}
