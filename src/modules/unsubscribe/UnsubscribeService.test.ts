import { describe, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import { UnsubscribeService } from './UnsubscribeService'
import { IUnsubscribeTokensRepository } from './interfaces/IUnsubscribeTokensRepository'
import { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'
import { UnsubscribeTokenRow } from '../../types'

/**
 * The hole these tests close: a second click on the unsubscribe link fell into the
 * same error as a forged token. Whoever clicked twice, or clicked the link of an
 * old e-mail, saw "error" on a routine that was already deactivated — and was left
 * not knowing whether they had managed to opt out.
 */

const HOUR = 60 * 60 * 1000

const token = (over: Partial<UnsubscribeTokenRow> = {}): UnsubscribeTokenRow => ({
  id: 't1', token: 'abc', routine_id: 'r1', routine_name: 'Suécia',
  email: 'dono@x.com', is_primary: true,
  expires_at: new Date(Date.now() + HOUR), used_at: null,
  created_at: new Date(), ...over,
})

/** `subscribed` decides what the state SELECT returns — it is what the service reads. */
function build(rec: UnsubscribeTokenRow | null, subscribed: boolean) {
  const markUsed = vi.fn().mockResolvedValue(undefined)
  const repo = {
    create:      vi.fn(),
    findByToken: vi.fn().mockResolvedValue(rec),
    markUsed,
  } as unknown as IUnsubscribeTokensRepository

  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT is_active')) return { rows: [{ is_active: subscribed }] }
    if (sql.includes('EXISTS'))           return { rows: [{ subscribed }] }
    return { rows: [] }
  })
  const db = { query } as unknown as Pool

  const svc = new UnsubscribeService(repo, {} as IRoutinesRepository, db)
  return { svc, query, markUsed }
}

describe('UnsubscribeService.process', () => {
  it('desativa a rotina no primeiro clique', async () => {
    const { svc, query, markUsed } = build(token(), false)

    const res = await svc.process('abc')

    expect(res).toMatchObject({ routineName: 'Suécia', isPrimary: true, alreadyUnsubscribed: false })
    expect(markUsed).toHaveBeenCalledWith('t1')
    expect(query.mock.calls.some(([sql]) => sql.includes('SET is_active = false'))).toBe(true)
  })

  it('no segundo clique reporta que já estava desativada, sem erro', async () => {
    const { svc, query, markUsed } = build(token({ used_at: new Date() }), false)

    const res = await svc.process('abc')

    expect(res.alreadyUnsubscribed).toBe(true)
    expect(markUsed).not.toHaveBeenCalled()
    expect(query.mock.calls.some(([sql]) => sql.includes('SET is_active = false'))).toBe(false)
  })

  it('link expirado numa rotina já desativada também reporta, sem erro', async () => {
    const { svc } = build(token({ expires_at: new Date(Date.now() - HOUR) }), false)

    await expect(svc.process('abc')).resolves.toMatchObject({ alreadyUnsubscribed: true })
  })

  it('token gasto numa rotina reativada pelo dono volta a ser erro', async () => {
    const { svc } = build(token({ used_at: new Date() }), true)

    await expect(svc.process('abc')).rejects.toThrow('Este link já foi utilizado')
  })

  it('link expirado numa rotina ainda ativa é erro de expiração', async () => {
    const { svc } = build(token({ expires_at: new Date(Date.now() - HOUR) }), true)

    await expect(svc.process('abc')).rejects.toThrow('Link expirado')
  })

  it('remove o CC no primeiro clique', async () => {
    const { svc, query } = build(token({ is_primary: false, email: 'cc@x.com' }), false)

    const res = await svc.process('abc')

    expect(res).toMatchObject({ email: 'cc@x.com', isPrimary: false, alreadyUnsubscribed: false })
    expect(query.mock.calls.some(([sql]) => sql.includes('cc_emails'))).toBe(true)
  })

  it('token inexistente é inválido', async () => {
    const { svc } = build(null, false)

    await expect(svc.process('abc')).rejects.toThrow('Token inválido')
  })
})
