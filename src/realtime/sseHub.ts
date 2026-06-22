import { FastifyInstance, FastifyReply } from 'fastify'
import { envelope } from './protocol'
import { HubBus, type TelemetryEvent } from './hubBus'
import { env } from '../config/env'
import { logger } from '../utils/logger'
import { toDateStr } from '../services/evaluation/EvaluationService'
import type { AdminJobRow, IScrapingJobRepository } from '../modules/scraping-jobs/interfaces/IScrapingJobRepository'

const HEARTBEAT_MS = 25_000
const RING_SIZE = 500
const JOB_RETENTION_MS = 60_000
const SWEEP_INTERVAL_MS = 60_000
// Entrada 'running' sem evento terminal por mais que isso é considerada órfã
// (worker caiu ou deploy no meio da execução) e é removida do liveJobs. Acima do
// running_timeout_min (10min) do job, dando margem ao término normal.
const STALE_LIVE_JOB_MS = 15 * 60_000

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
  userEmail: string | null
  orphanedAt: string | null
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
    userEmail: j.user_email,
    orphanedAt: j.orphaned_at ? new Date(j.orphaned_at).toISOString() : null,
  }
}

export class SseHub {
  private readonly clients = new Set<Client>()
  private readonly ring: RingEntry[] = []
  private globalId = 0
  private readonly liveJobs = new Map<string, JobView>()

  private readonly sweepTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly hubBus: HubBus,
    private readonly scrapingJobRepo: IScrapingJobRepository,
  ) {
    this.hubBus.onTelemetry((ev) => this.consume(ev))
    this.sweepTimer = setInterval(() => this.sweepStaleJobs(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  clientCount(): number {
    return this.clients.size
  }

  stop(): void {
    clearInterval(this.sweepTimer)
  }

  // Remove entradas 'running' órfãs (worker caiu/deploy no meio): sem evento
  // terminal além do timeout, elas ficariam eternamente como "Executando" e
  // seriam reentregues a cada conexão SSE. Limpa e avisa os clientes.
  private sweepStaleJobs(): void {
    const now = Date.now()
    for (const [requestId, view] of this.liveJobs) {
      if (view.status !== 'running') continue
      const since = view.runningSince ? new Date(view.runningSince).getTime() : NaN
      if (Number.isNaN(since) || now - since <= STALE_LIVE_JOB_MS) continue
      this.liveJobs.delete(requestId)
      this.broadcast('job.removed', { requestId })
      logger.warn({ requestId, ageMs: now - since }, 'Realtime: liveJob órfão removido (sem evento terminal)')
    }
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

  // Na 1ª aparição de um job ao vivo: casa a telemetria com a linha do banco
  // pelo requestId. Se existir, preenche o jobId (o worker não o conhece) e o
  // dono. Se NÃO existir, é telemetria órfã (job já finalizado/removido) — não
  // pode virar "Executando", então remove na hora.
  private enrichLiveJob(requestId: string): void {
    this.scrapingJobRepo
      .findByRequestId(requestId)
      .then(async (job) => {
        const view = this.liveJobs.get(requestId)
        if (!view) return
        if (!job) {
          this.liveJobs.delete(requestId)
          this.broadcast('job.removed', { requestId })
          logger.warn({ requestId }, 'Realtime: telemetria órfã descartada (sem job no banco)')
          return
        }
        let changed = false
        if (view.jobId !== job.id) { view.jobId = job.id; changed = true }
        // Backfill da rota a partir do banco: se a 1ª telemetria recebida não foi
        // job.started (ex.: hub reconectou no meio do job), o view nasce sem rota.
        if (!view.airline && job.airline) { view.airline = job.airline; changed = true }
        if (!view.origin && job.origin) { view.origin = job.origin; changed = true }
        if (!view.destination && job.destination) { view.destination = job.destination; changed = true }
        if (!view.flightDate && job.flight_date) { view.flightDate = toDateStr(job.flight_date); changed = true }
        const email = await this.scrapingJobRepo.findOwnerEmailByRequestId(requestId)
        if (email && view.userEmail !== email) { view.userEmail = email; changed = true }
        if (changed) this.broadcast('job.upsert', view)
      })
      .catch(() => undefined)
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
      userEmail: null,
      orphanedAt: null,
    }

    // A telemetria do worker não conhece jobId nem dono; ambos vêm do banco.
    // Na 1ª aparição, casa pelo requestId, preenche jobId/dono ou descarta órfão.
    if (!prev) this.enrichLiveJob(msg.requestId)

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
