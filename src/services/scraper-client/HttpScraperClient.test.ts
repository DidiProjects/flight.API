import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HttpScraperClient } from './HttpScraperClient'
import type { Env } from '../../config/env'
import { ScraperBusyError, type ScrapeBatchDispatch } from './IScraperClient'

const env = { SCRAPING_API_URL: 'http://scraping-api', SCRAPING_API_KEY: 'test-key' } as Env

// Route, airline and passengers belong to the batch; the date belongs to the item.
// That split is what lets the worker open the browser session once.
const payload: ScrapeBatchDispatch = {
  batchId: '11111111-1111-4111-8111-111111111111',
  airline: 'azul',
  origin: 'VCP',
  destination: 'LIS',
  passengers: 1,
  deadlineMs: 40 * 60_000,
  items: [
    { requestId: 'r1', jobId: 'j1', outboundDate: '2026-08-15' },
  ],
}

describe('HttpScraperClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('faz POST em /scrape/batch com X-API-Key e o payload', async () => {
    await new HttpScraperClient(env).dispatchBatch(payload)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://scraping-api/scrape/batch')
    expect(init.method).toBe('POST')
    expect(init.headers['X-API-Key']).toBe('test-key')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ batchId: payload.batchId, airline: 'azul', deadlineMs: 2_400_000 })
    expect(body.items).toEqual([{ requestId: 'r1', jobId: 'j1', outboundDate: '2026-08-15' }])
  })

  it('lança erro com o status quando a resposta não é ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' })
    await expect(new HttpScraperClient(env).dispatchBatch(payload)).rejects.toThrow(/500/)
  })

  it('lança ScraperBusyError com retryAfterMs no 503 (fila cheia)', async () => {
    fetchMock.mockResolvedValueOnce({ status: 503, json: async () => ({ retryAfterMs: 30_000 }) })
    await expect(new HttpScraperClient(env).dispatchBatch(payload)).rejects.toMatchObject({
      name: 'ScraperBusyError',
      retryAfterMs: 30_000,
    })
    expect(ScraperBusyError).toBeDefined()
  })
})
