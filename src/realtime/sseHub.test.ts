import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { SseHub } from './sseHub'
import { HubBus } from './hubBus'
import { envelope } from './protocol'

let app: FastifyInstance
let base: string
let hubBus: HubBus
const mockRepo = {
  listForAdmin: async () => [],
  findByRequestId: async (rid: string) => (rid === 'orphan' ? null : { id: `job-${rid}` }),
  findOwnerEmailsByRequestId: async () => [],
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sign(role: 'user' | 'admin'): string {
  return app.jwt.sign({ sub: 'u', role, email: 'e@x', mustChangePassword: false })
}

/** Lê o stream SSE em background acumulando num buffer. */
function drain(res: Response): { buf: () => string; stop: () => void } {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let stopped = false
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || stopped) break
        buf += dec.decode(value, { stream: true })
      }
    } catch { /* cancelado */ }
  })()
  return { buf: () => buf, stop: () => { stopped = true; reader.cancel().catch(() => {}) } }
}

beforeAll(async () => {
  app = Fastify()
  await app.register(fastifyJwt, { secret: 'x'.repeat(40) })
  hubBus = new HubBus()
  const sseHub = new SseHub(hubBus, mockRepo as never)
  await app.register(
    async (api) => { await api.register(sseHub.plugin, { prefix: '/admin' }) },
    { prefix: '/flight' },
  )
  await app.listen({ port: 0 })
  const addr = app.server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}/flight/admin/stream`
})

afterAll(async () => { await app.close() })

describe('sseHub /admin/stream', () => {
  it('rejeita sem token (401) e não-admin (403)', async () => {
    expect((await fetch(base)).status).toBe(401)
    const r = await fetch(`${base}?token=${sign('user')}`)
    expect(r.status).toBe(403)
    await r.body?.cancel()
  })

  it('admin recebe text/event-stream + job.snapshot e o fan-out de telemetria', async () => {
    const res = await fetch(`${base}?token=${sign('admin')}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const stream = drain(res)
    await wait(100)
    expect(stream.buf()).toContain('event: job.snapshot')

    hubBus.publishTelemetry({
      workerId: 'w1',
      message: envelope('job.started', { airline: 'azul', origin: 'VCP', destination: 'GRU', flightDate: '2026-07-01', startedAt: new Date().toISOString() }, { requestId: 'rX', seq: 1 }),
    })
    await wait(150)
    expect(stream.buf()).toContain('event: job.upsert')
    expect(stream.buf()).toContain('"requestId":"rX"')
    expect(stream.buf()).toContain('event: job.event')

    stream.stop()
  })

  it('descarta telemetria órfã (sem job correspondente no banco)', async () => {
    const res = await fetch(`${base}?token=${sign('admin')}`)
    const stream = drain(res)
    await wait(100)

    hubBus.publishTelemetry({
      workerId: 'w1',
      message: envelope('job.started', { airline: 'azul', origin: 'VCP', destination: 'GRU', flightDate: '2026-07-01', startedAt: new Date().toISOString() }, { requestId: 'orphan', seq: 1 }),
    })
    await wait(150)

    expect(stream.buf()).toContain('event: job.removed')
    expect(stream.buf()).toContain('"requestId":"orphan"')

    stream.stop()
  })
})
