import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { attachWorkerGateway, requestCancel, hasWorkers, closeWorkerGateway } from './workerGateway'
import { hubBus } from './hubBus'

// FLIGHT_API_KEY vem do src/test/env-setup.ts ('test-key').
const KEY = 'test-key'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let server: http.Server
let url: string

beforeAll(async () => {
  server = http.createServer()
  attachWorkerGateway(server)
  await new Promise<void>((r) => server.listen(0, r))
  const addr = server.address() as { port: number }
  url = `ws://127.0.0.1:${addr.port}/realtime/worker`
})

afterAll(async () => {
  closeWorkerGateway()
  await new Promise<void>((r) => server.close(() => r()))
})

function connect(query: string): WebSocket {
  return new WebSocket(`${url}?${query}`)
}

describe('workerGateway', () => {
  it('rejeita upgrade com key inválida', async () => {
    const ws = connect('key=wrong&workerId=t')
    const rejected = await new Promise<boolean>((res) => {
      ws.addEventListener('error', () => res(true))
      ws.addEventListener('open', () => res(false))
    })
    expect(rejected).toBe(true)
  })

  it('faz handshake (hello.ack), recebe telemetria e roteia cancel com ack', async () => {
    const telemetry: Array<{ type: string; requestId?: string }> = []
    const onTel = (ev: { message: { type: string; requestId?: string } }) =>
      telemetry.push({ type: ev.message.type, requestId: ev.message.requestId })
    hubBus.on('telemetry', onTel)

    const ws = connect(`key=${KEY}&workerId=test`)
    const got: Array<{ type: string; id: string; requestId?: string }> = []
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
      got.push(m)
      // responde o comando cancel com ack
      if (m.type === 'cancel') {
        ws.send(JSON.stringify({ v: 1, type: 'cancel.ack', id: 'a', requestId: m.requestId, ts: new Date().toISOString(), payload: { correlationId: m.id, result: 'aborted' } }))
      }
    })
    await new Promise<void>((r) => ws.addEventListener('open', () => r()))
    await wait(80)

    expect(got.some((m) => m.type === 'hello.ack')).toBe(true)
    expect(hasWorkers()).toBe(true)

    // telemetria sobe ao hubBus
    ws.send(JSON.stringify({ v: 1, type: 'job.started', id: 'j', requestId: 'r1', seq: 1, ts: new Date().toISOString(), payload: { airline: 'azul' } }))
    await wait(80)
    expect(telemetry.some((t) => t.type === 'job.started' && t.requestId === 'r1')).toBe(true)

    // cancel roundtrip
    const dispatch = await requestCancel('r1')
    expect(dispatch).toEqual({ delivery: 'dispatched', result: 'aborted' })

    // sem worker dono → no_worker
    expect(await requestCancel('desconhecido')).toEqual({ delivery: 'no_worker' })

    hubBus.off('telemetry', onTel)
    ws.close()
  })
})
