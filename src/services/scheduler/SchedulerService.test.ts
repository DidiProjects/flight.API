import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchedulerService } from './SchedulerService'
import type { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import type { INotificationsService } from '../notifications/interfaces/INotificationsService'
import type { Env } from '../../config/env'
import type { RoutineRow } from '../../types'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRoutine(overrides: Partial<RoutineRow> = {}): RoutineRow {
  return {
    id:                    'aaaaaaaa-0000-0000-0000-000000000001',
    user_id:               'bbbbbbbb-0000-0000-0000-000000000002',
    name:                  'Teste VCP→LIS',
    airline:               'azul',
    origin:                'VCP',
    destination:           'LIS',
    // pg DATE columns chegam como Date objects em runtime, apesar de tipado como string
    outbound_start:        new Date('2026-05-01') as unknown as string,
    outbound_end:          new Date('2026-05-10') as unknown as string,
    return_start:          null,
    return_end:            null,
    passengers:            1,
    target_brl:            1500,
    target_pts:            null,
    target_hyb_pts:        null,
    target_hyb_brl:        null,
    margin:                0.1,
    priority:              'brl',
    notification_mode:     'alert_only',
    notification_frequency:'hourly',
    end_of_period_time:    null,
    cc_emails:             [],
    pending_request_id:    null,
    pending_request_at:    null,
    is_active:             true,
    created_at:            new Date(),
    updated_at:            new Date(),
    ...overrides,
  }
}

function makeEnv(): Env {
  return {
    NODE_ENV:                  'test',
    PORT:                      3011,
    POSTGRES_HOST:             'localhost',
    POSTGRES_PORT:             5432,
    POSTGRES_USER:             'admin',
    POSTGRES_PASSWORD:         'admin',
    POSTGRES_DB:               'test',
    JWT_SECRET:                'x'.repeat(32),
    JWT_EXPIRES_IN:            '15m',
    JWT_REFRESH_EXPIRES_IN:    '30d',
    SCRAPE_INTERVAL_MS:        3_600_000,
    SCRAPE_INTERVAL_JITTER_MS: 300_000,
    SCRAPING_API_URL:          'http://scraping-api',
    SCRAPING_API_KEY:          'test-key',
    FLIGHT_API_KEY:            'flight-key',
    SMTP_HOST:                 'smtp.test',
    SMTP_PORT:                 587,
    SMTP_USER:                 'test@test.com',
    SMTP_PASSWORD:             'pass',
    SMTP_FROM:                 'test@test.com',
    ADMIN_EMAIL:               'admin@test.com',
    ADMIN_PASSWORD_INITIAL:    'changeme123',
    API_BASE_URL:              'http://localhost:3011/flight',
    FRONTEND_URL:              'http://localhost:3000',
    LOG_LEVEL:                 'silent',
  } as Env
}

function makeRepoMock(routine: RoutineRow): IRoutinesRepository {
  return {
    findByIdAdmin:      vi.fn().mockResolvedValue(routine),
    setPendingRequest:  vi.fn().mockResolvedValue(undefined),
    clearPendingRequest:vi.fn().mockResolvedValue(undefined),
  } as unknown as IRoutinesRepository
}

function makeNotifMock(): INotificationsService {
  return {} as unknown as INotificationsService
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SchedulerService.dispatchOne — payload para scraping.API', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ requestId: 'r', position: 0 }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('envia datas no formato YYYY-MM-DD mesmo quando pg retorna Date objects', async () => {
    const routine = makeRoutine()
    const svc = new SchedulerService(makeRepoMock(routine), makeNotifMock(), makeEnv())

    await svc.dispatchOne(routine.id)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.outboundStart).toBe('2026-05-01')
    expect(body.outboundEnd).toBe('2026-05-10')
  })

  it('omite returnStart e returnEnd quando a rotina é só de ida', async () => {
    const routine = makeRoutine({ return_start: null, return_end: null })
    const svc = new SchedulerService(makeRepoMock(routine), makeNotifMock(), makeEnv())

    await svc.dispatchOne(routine.id)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).not.toHaveProperty('returnStart')
    expect(body).not.toHaveProperty('returnEnd')
  })

  it('envia returnStart e returnEnd no formato YYYY-MM-DD quando presentes', async () => {
    const routine = makeRoutine({
      return_start: new Date('2026-05-15') as unknown as string,
      return_end:   new Date('2026-05-20') as unknown as string,
    })
    const svc = new SchedulerService(makeRepoMock(routine), makeNotifMock(), makeEnv())

    await svc.dispatchOne(routine.id)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.returnStart).toBe('2026-05-15')
    expect(body.returnEnd).toBe('2026-05-20')
  })

  it('inclui todos os campos obrigatórios do contrato', async () => {
    const routine = makeRoutine()
    const svc = new SchedulerService(makeRepoMock(routine), makeNotifMock(), makeEnv())

    await svc.dispatchOne(routine.id)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      routineId:    routine.id,
      airline:      'azul',
      origin:       'VCP',
      destination:  'LIS',
      passengers:   1,
    })
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('envia X-API-Key no header', async () => {
    const routine = makeRoutine()
    const svc = new SchedulerService(makeRepoMock(routine), makeNotifMock(), makeEnv())

    await svc.dispatchOne(routine.id)

    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-API-Key']).toBe('test-key')
  })
})
