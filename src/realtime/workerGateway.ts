import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { env } from '../config/env'
import { logger } from '../utils/logger'
import { envelope, type AnyMessage, type CancelResult, type JobStateSnapshot } from './protocol'
import { HubBus } from './hubBus'

const WS_PATH = '/flight/realtime/worker'
const HEARTBEAT_MS = 30_000
const CANCEL_ACK_TIMEOUT_MS = 5_000

interface LiveSocket extends WebSocket {
  isAlive?: boolean
  workerId?: string
}

export interface CancelDispatch {
  delivery: 'dispatched' | 'no_worker'
  result?: CancelResult
}

export interface ICancelDispatcher {
  requestCancel(requestId: string): Promise<CancelDispatch>
}

export class WorkerGateway implements ICancelDispatcher {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly workers = new Map<string, LiveSocket>()
  private readonly requestToWorker = new Map<string, string>()
  private readonly pendingCancels = new Map<string, (result: CancelResult) => void>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly hubBus: HubBus) {}

  hasWorkers(): boolean {
    return this.workers.size > 0
  }

  requestCancel(requestId: string): Promise<CancelDispatch> {
    const workerId = this.requestToWorker.get(requestId)
    const ws = workerId ? this.workers.get(workerId) : undefined
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ delivery: 'no_worker' })
    }

    const cmd = envelope('cancel', {}, { requestId })
    return new Promise<CancelDispatch>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCancels.delete(cmd.id)
        resolve({ delivery: 'dispatched' })
      }, CANCEL_ACK_TIMEOUT_MS)
      this.pendingCancels.set(cmd.id, (result) => {
        clearTimeout(timer)
        this.pendingCancels.delete(cmd.id)
        resolve({ delivery: 'dispatched', result })
      })
      ws.send(JSON.stringify(cmd))
    })
  }

  attach(server: Server): void {
    if (env.REALTIME_ENABLED === 'false') {
      logger.info('Hub WS: desabilitado (REALTIME_ENABLED=false)')
      return
    }

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      if (url.pathname !== WS_PATH) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      if (url.searchParams.get('key') !== env.FLIGHT_API_KEY) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const workerId = url.searchParams.get('workerId') ?? 'unknown'
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws as LiveSocket, workerId))
    })

    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.wss.clients as Set<LiveSocket>) {
        if (ws.isAlive === false) {
          ws.terminate()
          continue
        }
        ws.isAlive = false
        ws.ping()
      }
    }, HEARTBEAT_MS)

    logger.info({ path: WS_PATH }, 'Hub WS: gateway anexado')
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.wss.clients.forEach((ws) => ws.terminate())
    this.wss.close()
  }

  private onConnection(ws: LiveSocket, workerId: string): void {
    ws.isAlive = true
    ws.workerId = workerId

    const previous = this.workers.get(workerId)
    if (previous && previous !== ws) previous.terminate()
    this.workers.set(workerId, ws)
    this.hubBus.publishWorkerStatus(workerId, true)
    logger.info({ workerId }, 'Hub WS: worker conectado')

    ws.send(JSON.stringify(envelope('hello.ack', { heartbeatMs: HEARTBEAT_MS, serverTime: new Date().toISOString() })))

    ws.on('pong', () => { ws.isAlive = true })
    ws.on('message', (data) => this.handleMessage(workerId, data.toString()))
    ws.on('close', () => {
      if (this.workers.get(workerId) === ws) {
        this.workers.delete(workerId)
        this.hubBus.publishWorkerStatus(workerId, false)
        logger.warn({ workerId }, 'Hub WS: worker desconectado')
      }
    })
    ws.on('error', (err) => logger.warn({ workerId, err }, 'Hub WS: erro de socket'))
  }

  private handleMessage(workerId: string, raw: string): void {
    let msg: AnyMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.requestId) this.requestToWorker.set(msg.requestId, workerId)

    switch (msg.type) {
      case 'worker.hello':
        logger.info({ workerId, payload: msg.payload }, 'Hub WS: worker.hello')
        break
      case 'worker.snapshot': {
        const jobs = (msg.payload.jobs as JobStateSnapshot[]) ?? []
        jobs.forEach((j) => this.requestToWorker.set(j.requestId, workerId))
        this.hubBus.publishSnapshot({ workerId, jobs })
        break
      }
      case 'worker.heartbeat':
        break
      case 'job.queued':
      case 'job.started':
      case 'job.progress':
      case 'job.log':
      case 'job.finished':
        this.hubBus.publishTelemetry({ workerId, message: msg })
        if (msg.type === 'job.finished' && msg.requestId) this.requestToWorker.delete(msg.requestId)
        break
      case 'cancel.ack': {
        const correlationId = msg.payload.correlationId as string | undefined
        const resolver = correlationId ? this.pendingCancels.get(correlationId) : undefined
        resolver?.(msg.payload.result as CancelResult)
        break
      }
      case 'pong':
        break
      default:
        logger.debug({ workerId, type: msg.type }, 'Hub WS: tipo desconhecido')
    }
  }
}
