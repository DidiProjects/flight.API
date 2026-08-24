import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { ScrapingJobRepository } from './ScrapingJobRepository'

/**
 * The worker lease: who may take a running job back, and when.
 *
 * Runs against a real Postgres because the whole decision is in the SQL of
 * `claimNextJob` and `reclaimExpiredJobs` — the interval arithmetic and the NULL
 * handling are exactly what a mock would paper over. Skipped without
 * TEST_DATABASE_URL.
 *
 * Locally:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test
 */

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'lease_it'

// The production values (SchedulerService): heartbeat older than this is an
// expired lease; with no heartbeat at all, the worker has the grace to send one.
const LEASE_TIMEOUT_SEC = 90
const LEASE_GRACE_SEC = 60
const MAX_RUN_MIN = 25

const describeIt = DB_URL ? describe : describe.skip

describeIt('lease do worker (integração / Postgres real)', () => {
  let pool: Pool
  let jobs: ScrapingJobRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.scraping_jobs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        airline             VARCHAR(20) NOT NULL,
        origin              VARCHAR(10) NOT NULL,
        destination         VARCHAR(10) NOT NULL,
        flight_date         DATE NOT NULL,
        return_date         DATE,
        status              VARCHAR(20) NOT NULL DEFAULT 'pending',
        priority            INT NOT NULL DEFAULT 0,
        retry_count         INT NOT NULL DEFAULT 0,
        max_retries         INT NOT NULL DEFAULT 3,
        next_run_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_success_at     TIMESTAMPTZ,
        last_failure_at     TIMESTAMPTZ,
        last_error          TEXT,
        running_since       TIMESTAMPTZ,
        running_timeout_min INT NOT NULL DEFAULT 20,
        request_id          UUID,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        cancel_requested_at TIMESTAMPTZ,
        orphaned_at         TIMESTAMPTZ,
        started_at          TIMESTAMPTZ,
        last_heartbeat_at   TIMESTAMPTZ
      )`)
    jobs = new ScrapingJobRepository(pool)
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await pool.end()
    }
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.scraping_jobs`)
  })

  /** A job that already ran once: it carries the heartbeat of THAT run. */
  const jobComHeartbeatVelho = async (horas = 72) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.scraping_jobs
         (airline, origin, destination, flight_date, status, last_heartbeat_at)
       VALUES ('britishairways','LGW','GRU','2026-12-11','success', NOW() - ($1 || ' hours')::interval)
       RETURNING id`,
      [horas])
    return rows[0]!.id
  }

  const estado = async (id: string) => {
    const { rows } = await pool.query(
      `SELECT status, retry_count, last_heartbeat_at, running_since FROM ${SCHEMA}.scraping_jobs WHERE id = $1`,
      [id])
    return rows[0]!
  }

  const reclaim = () => jobs.reclaimExpiredJobs(LEASE_TIMEOUT_SEC, LEASE_GRACE_SEC, MAX_RUN_MIN)

  // ── a regressão ───────────────────────────────────────────────────────────
  // Medido em desenvolvimento em 2026-08-23 e visto em produção no dia 24: o job
  // era reivindicado, herdava o heartbeat da execução ANTERIOR, e o ciclo de
  // lease o retomava segundos depois — o worker recebia cancelamento no meio do
  // scrape e o callback chegava órfão, sem contar retry nem aplicar backoff. Uma
  // rota da BA que falhava ficou horas repetindo sem nunca virar `dead`.
  it('reivindicar zera o heartbeat da execução anterior', async () => {
    const id = await jobComHeartbeatVelho()

    const claimed = await jobs.claimNextJob('britishairways')

    expect(claimed?.id).toBe(id)
    expect((await estado(id)).last_heartbeat_at).toBeNull()
  })

  it('job recém-reivindicado NÃO é retomado pelo ciclo de lease', async () => {
    const id = await jobComHeartbeatVelho()
    await jobs.claimNextJob('britishairways')
    await jobs.markRunning(id, '22222222-2222-2222-2222-222222222222')

    const { lost, hung } = await reclaim()

    // Pelo request_id devolvido E pelo estado da linha: sem o markRunning acima,
    // o reclaim retomaria o job devolvendo request_id nulo, e a asserção só
    // sobre `lost` passaria sem ver nada.
    expect(lost).toEqual([])
    expect(hung).toEqual([])
    expect((await estado(id)).status).toBe('running')
  })

  // A lease continua existindo: o que muda é de onde ela conta.
  it('sem heartbeat e passada a graça, o job é retomado', async () => {
    const id = await jobComHeartbeatVelho()
    await jobs.claimNextJob('britishairways')
    await jobs.markRunning(id, '33333333-3333-3333-3333-333333333333')
    await pool.query(
      `UPDATE ${SCHEMA}.scraping_jobs SET running_since = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [id])

    const { lost } = await reclaim()

    expect(lost).toEqual(['33333333-3333-3333-3333-333333333333'])
    expect((await estado(id)).status).toBe('pending')
  })

  it('heartbeat do worker renova a lease e o job fica', async () => {
    const id = await jobComHeartbeatVelho()
    await jobs.claimNextJob('britishairways')
    await jobs.markRunning(id, '44444444-4444-4444-4444-444444444444')
    await pool.query(
      `UPDATE ${SCHEMA}.scraping_jobs SET running_since = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [id])
    await jobs.markHeartbeat(['44444444-4444-4444-4444-444444444444'])

    const { lost } = await reclaim()

    expect(lost).toEqual([])
    expect((await estado(id)).status).toBe('running')
  })

  it('heartbeat velho da execução em curso ainda expira a lease', async () => {
    const id = await jobComHeartbeatVelho()
    await jobs.claimNextJob('britishairways')
    await jobs.markRunning(id, '55555555-5555-5555-5555-555555555555')
    await pool.query(
      `UPDATE ${SCHEMA}.scraping_jobs
          SET running_since = NOW() - INTERVAL '10 minutes',
              last_heartbeat_at = NOW() - INTERVAL '5 minutes'
        WHERE id = $1`, [id])

    const { lost } = await reclaim()

    expect(lost).toEqual(['55555555-5555-5555-5555-555555555555'])
  })

  it('sucesso e falha não deixam heartbeat para trás', async () => {
    const id = await jobComHeartbeatVelho()
    await jobs.claimNextJob('britishairways')
    await jobs.markHeartbeat([])
    await jobs.markSuccess(id, new Date(Date.now() + 60_000))
    expect((await estado(id)).last_heartbeat_at).toBeNull()

    await pool.query(
      `UPDATE ${SCHEMA}.scraping_jobs SET status='running', last_heartbeat_at = NOW() WHERE id = $1`, [id])
    await jobs.markFailed(id, 'boom', new Date(Date.now() + 60_000))
    expect((await estado(id)).last_heartbeat_at).toBeNull()
  })
})
