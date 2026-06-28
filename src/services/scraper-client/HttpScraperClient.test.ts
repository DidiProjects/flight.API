import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HttpScraperClient } from './HttpScraperClient'
import type { Env } from '../../config/env'
import { ScraperBusyError, type ScrapeDispatch } from './IScraperClient'

const env = { SCRAPING_API_URL: 'http://scraping-api', SCRAPING_API_KEY: 'test-key' } as Env

const payload: ScrapeDispatch = {
  requestId: 'r1',
  routineId: 'j1',
  airline: 'azul',
  origin: 'VCP',
  destination: 'LIS',
  outboundStart: '2026-08-15',
  outboundEnd: '2026-08-15',
  passengers: 1,
}

describe('HttpScraperClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('faz POST em /scrape com X-API-Key e o payload', async () => {
    await new HttpScraperClient(env).dispatch(payload)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://scraping-api/scrape')
    expect(init.method).toBe('POST')
    expect(init.headers['X-API-Key']).toBe('test-key')
    expect(JSON.parse(init.body)).toMatchObject({ requestId: 'r1', airline: 'azul' })
  })

  it('lança erro com o status quando a resposta não é ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' })
    await expect(new HttpScraperClient(env).dispatch(payload)).rejects.toThrow(/500/)
  })

  it('lança ScraperBusyError com retryAfterMs no 503 (fila cheia)', async () => {
    fetchMock.mockResolvedValueOnce({ status: 503, json: async () => ({ retryAfterMs: 30_000 }) })
    await expect(new HttpScraperClient(env).dispatch(payload)).rejects.toMatchObject({
      name: 'ScraperBusyError',
      retryAfterMs: 30_000,
    })
    expect(ScraperBusyError).toBeDefined()
  })
})
