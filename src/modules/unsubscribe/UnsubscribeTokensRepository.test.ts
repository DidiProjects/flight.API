import { describe, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import { UnsubscribeTokensRepository } from './UnsubscribeTokensRepository'

const DAY = 24 * 60 * 60 * 1000

describe('UnsubscribeTokensRepository.create', () => {
  it('dá 30 dias de validade ao token — o link vive numa caixa de entrada', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const repo = new UnsubscribeTokensRepository({ query } as unknown as Pool)

    const before = Date.now()
    await repo.create('r1', 'dono@x.com', true)

    const [, params] = query.mock.calls[0]
    const expiresAt = (params as unknown[])[4] as Date
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(30 * DAY - 1000)
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(30 * DAY + 1000)
  })
})
