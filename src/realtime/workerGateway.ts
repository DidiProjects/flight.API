import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { env } from '../config/env'
import { logger } from '../utils/logger'
import { envelope, type AnyMessage, type CancelResult, type JobStateSnapshot } from './protocol'
import { publishTelemetry, publishSnapshot, publishWorkerStatus } from './hubBus'

/**
 * Gateway WS hub ← workers (scraping.API). Anexado ao http server do Fastify no
 * path /realtime/worker. Auth por query param `key` (= FLIGHT_API_KEY) no upgrade
 * (o WebSocket nativo do Node não envia headers). Heartbeat ping/pong com flag
 * isAlive derruba conexões mortas (features.md §13).
 */

const WS_PATH = '/realtime/worker'
const HEARTBEAT_MS = 30_000
const CANCEL_ACK_TIMEOUT_MS = 5_000

interface LiveSocket extends WebSocket {
  isAlive?: boolean
  workerId?: string
}

const wss = new WebSocketServer({ noServer: true })
const workers = new Map<string, LiveSocket>() // workerId -> socket
const requestToWorker = new Map<string, string>() // requestId -> workerId
const pendingCancels = new Map<string, (result: CancelResult) => void>() // correlationId -> resolver

export interface CancelDispatch {
  delivery: 'dispatched' | 'no_worker'
  result?: CancelResult
}

/** Há algum worker conectado? */
export function hasWorkers(): boolean {
  return workers.size > 0
}

/**
 * Solicita cancelamento de um job ao worker dono. Se nenhum worker está com o
 * job, retorna 'no_worker' (Stage 4 persiste a intenção). Caso contrário envia
 * o comando e aguarda o ack (com timeout).
 */
export function requestCancel(requestId: string): Promise<CancelDispatch> {
  const workerId = requestToWorker.get(requestId)
  const ws = workerId ? workers.get(workerId) : undefined
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ delivery: 'no_worker' })
  }

  const cmd = envelope('cancel', {}, { requestId })
  return new Promise<CancelDispatch>((resolve) => {
    const timer = setTimeout(() => {
      pendingCancels.delete(cmd.id)
      resolve({ delivery: 'dispatched' }) // enviado, ack não chegou a tempo
    }, CANCEL_ACK_TIMEOUT_MS)
    pendingCancels.set(cmd.id, (result) => {
      clearTimeout(timer)
      pendingCancels.delete(cmd.id)
      resolve({ delivery: 'dispatched', result })
    })
    ws.send(JSON.stringify(cmd))
  })
}

function handleMessage(workerId: string, raw: string): void {
  let msg: AnyMessage
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  // Mantém o mapa requestId -> worker atualizado a partir de qualquer evento de job.
  if (msg.requestId) requestToWorker.set(msg.requestId, workerId)

  switch (msg.type) {
    case 'worker.hello':
      logger.info({ workerId, payload: msg.payload }, 'Hub WS: worker.hello')
      break
    case 'worker.snapshot': {
      const jobs = (msg.payload.jobs as JobStateSnapshot[]) ?? []
      jobs.forEach((j) => requestToWorker.set(j.requestId, workerId))
      publishSnapshot({ workerId, jobs })
      break
    }
    case 'worker.heartbeat':
      break
    case 'job.queued':
    case 'job.started':
    case 'job.progress':
    case 'job.log':
    case 'job.finished':
      publishTelemetry({ workerId, message: msg })
      if (msg.type === 'job.finished' && msg.requestId) requestToWorker.delete(msg.requestId)
      break
    case 'cancel.ack': {
      const correlationId = msg.payload.correlationId as string | undefined
      const resolver = correlationId ? pendingCancels.get(correlationId) : undefined
      resolver?.(msg.payload.result as CancelResult)
      break
    }
    case 'pong':
      break
    default:
      logger.debug({ workerId, type: msg.type }, 'Hub WS: tipo desconhecido')
  }
}

function onConnection(ws: LiveSocket, workerId: string): void {
  ws.isAlive = true
  ws.workerId = workerId

  // Se já havia um socket para esse workerId, encerra o antigo.
  const previous = workers.get(workerId)
  if (previous && previous !== ws) previous.terminate()
  workers.set(workerId, ws)
  publishWorkerStatus(workerId, true)
  logger.info({ workerId }, 'Hub WS: worker conectado')

  ws.send(JSON.stringify(envelope('hello.ack', { heartbeatMs: HEARTBEAT_MS, serverTime: new Date().toISOString() })))

  ws.on('pong', () => {
    ws.isAlive = true
  })
  ws.on('message', (data) => handleMessage(workerId, data.toString()))
  ws.on('close', () => {
    if (workers.get(workerId) === ws) {
      workers.delete(workerId)
      publishWorkerStatus(workerId, false)
      logger.warn({ workerId }, 'Hub WS: worker desconectado')
    }
  })
  ws.on('error', (err) => logger.warn({ workerId, err }, 'Hub WS: erro de socket'))
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function attachWorkerGateway(server: Server): void {
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
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws as LiveSocket, workerId))
  })

  // Heartbeat: derruba conexões que não respondem ao ping.
  heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients as Set<LiveSocket>) {
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

export function closeWorkerGateway(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  wss.clients.forEach((ws) => ws.terminate())
  wss.close()
}
