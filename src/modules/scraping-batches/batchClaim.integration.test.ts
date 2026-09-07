import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { ScrapingBatchRepository } from './ScrapingBatchRepository'
import { ScrapingJobRepository } from '../scraping-jobs/ScrapingJobRepository'

/**
 * The rule that makes a batch a batch: while it is live, none of its items may be
 * claimed again.
 *
 * Against a real Postgres because the whole guarantee is in SQL — the eligibility
 * predicate, the route grouping of the claim and the transaction around them. A mock
 * would assert that we called a function, not that the database refuses to hand the
 * same item to two dispatchers.
 *
 * Skipped without TEST_DATABASE_URL.
 */

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'batch_claim_it'

const describeIt = DB_URL ? describe : describe.skip

describeIt('claim de lote (integração / Postgres real)', () => {
  let pool: Pool
  let batches: ScrapingBatchRepository
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
        last_heartbeat_at   TIMESTAMPTZ,
        batch_id            UUID
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.scraping_batches (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        airline        VARCHAR(20) NOT NULL,
        origin         VARCHAR(10) NOT NULL,
        destination    VARCHAR(10) NOT NULL,
        status         VARCHAR(20) NOT NULL DEFAULT 'dispatched',
        item_count     INT NOT NULL,
        received_count INT NOT NULL DEFAULT 0,
        close_reason   TEXT,
        superseded_by  UUID,
        attempt        INT NOT NULL DEFAULT 1,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at      TIMESTAMPTZ
      )`)
    batches = new ScrapingBatchRepository(pool)
    jobs = new ScrapingJobRepository(pool)
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await pool.end()
    }
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.scraping_jobs, ${SCHEMA}.scraping_batches`)
  })

  const criaJob = async (over: Partial<{ origin: string; destination: string; date: string; airline: string; priority: number }> = {}) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.scraping_jobs (airline, origin, destination, flight_date, return_date, priority)
       VALUES ($1, $2, $3, $4, $4::date + 7, $5) RETURNING id`,
      [over.airline ?? 'britishairways', over.origin ?? 'LHR', over.destination ?? 'GRU', over.date ?? '2026-12-11', over.priority ?? 0],
    )
    return rows[0]!.id
  }

  it('um lote de 1 item é o comportamento anterior: reivindica e marca running', async () => {
    const id = await criaJob()

    const claimed = await batches.claimBatch('britishairways', 1)

    expect(claimed?.items.map((i) => i.id)).toEqual([id])
    expect(claimed?.batch.item_count).toBe(1)
    const { rows } = await pool.query(`SELECT status, batch_id FROM ${SCHEMA}.scraping_jobs WHERE id = $1`, [id])
    expect(rows[0].status).toBe('running')
    expect(rows[0].batch_id).toBe(claimed?.batch.id)
  })

  it('agrupa por ROTA: só entram no lote itens da mesma origem/destino', async () => {
    await criaJob({ date: '2026-12-11', priority: 10 })
    await criaJob({ date: '2026-12-12', priority: 5 })
    const outraRota = await criaJob({ destination: 'GIG', date: '2026-12-11', priority: 9 })

    const claimed = await batches.claimBatch('britishairways', 8)

    expect(claimed?.items).toHaveLength(2)
    expect(claimed?.items.map((i) => i.id)).not.toContain(outraRota)
    expect(claimed?.batch.destination).toBe('GRU')
  })

  // A regra 3, em SQL. Sem ela o item que falhou volta sozinho pelo backoff de 60s e
  // gasta uma sessão inteira de navegador para um item só.
  it('item de lote VIVO não é reivindicado de novo, nem mesmo depois de falhar', async () => {
    const id = await criaJob()
    const primeiro = await batches.claimBatch('britishairways', 1)
    expect(primeiro).not.toBeNull()

    await jobs.holdForBatch(id, 'sem cards')

    // Elegível por status e por next_run_at — só o lote vivo o segura.
    const segundo = await batches.claimBatch('britishairways', 1)
    expect(segundo).toBeNull()
  })

  it('fechado o lote, o item volta a ser reivindicável', async () => {
    const id = await criaJob()
    const primeiro = await batches.claimBatch('britishairways', 1)
    await jobs.holdForBatch(id, 'sem cards')
    await batches.close(primeiro!.batch.id, 'completed', 'completed')
    await jobs.settleBatchItem(id, { penalise: true, nextRunAt: new Date(Date.now() - 1000), error: 'falhou' })

    const segundo = await batches.claimBatch('britishairways', 1)

    expect(segundo?.items.map((i) => i.id)).toEqual([id])
  })

  // O invariante do índice único parcial: dois disparos manuais simultâneos na mesma
  // rota produziriam duas sessões da mesma companhia contra o mesmo site.
  it('não abre um segundo lote vivo para a mesma rota', async () => {
    await criaJob({ date: '2026-12-11' })
    await criaJob({ date: '2026-12-12' })
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rota_viva_it
        ON ${SCHEMA}.scraping_batches (airline, origin, destination)
        WHERE status IN ('dispatched','running','closing')`)

    await batches.claimBatch('britishairways', 1)

    await expect(batches.claimBatch('britishairways', 1)).rejects.toThrow(/duplicate key/i)
  })

  describe('settleBatchItem', () => {
    it('sem penalidade: volta a pending, retry_count intocado e fora do lote', async () => {
      const id = await criaJob()
      const c = await batches.claimBatch('britishairways', 1)
      await pool.query(`UPDATE ${SCHEMA}.scraping_jobs SET retry_count = 2 WHERE id = $1`, [id])
      await batches.close(c!.batch.id, 'superseded', 'superseded')

      await jobs.settleBatchItem(id, { penalise: false, nextRunAt: new Date(), error: null })

      const { rows } = await pool.query(`SELECT status, retry_count, batch_id FROM ${SCHEMA}.scraping_jobs WHERE id = $1`, [id])
      expect(rows[0]).toMatchObject({ status: 'pending', retry_count: 2, batch_id: null })
    })

    it('com penalidade: conta uma retentativa e morre no limite', async () => {
      const id = await criaJob()
      await batches.claimBatch('britishairways', 1)
      await pool.query(`UPDATE ${SCHEMA}.scraping_jobs SET retry_count = 2, max_retries = 3 WHERE id = $1`, [id])

      await jobs.settleBatchItem(id, { penalise: true, nextRunAt: new Date(), error: 'estourou' })

      const { rows } = await pool.query(`SELECT status, retry_count FROM ${SCHEMA}.scraping_jobs WHERE id = $1`, [id])
      expect(rows[0]).toMatchObject({ status: 'dead', retry_count: 3 })
    })
  })

  // 10.1 do desenho: pauseAirlineForBlock devolve TODO job da companhia para 'pending'
  // com request_id nulo, inclusive os running. Se o lote continuasse vivo, esses itens
  // ficariam pendentes, vencidos e invisíveis ao claim — para sempre.
  it('bloqueio da companhia fecha os lotes vivos e destrava os itens', async () => {
    const id = await criaJob()
    await batches.claimBatch('britishairways', 1)

    await batches.closeLiveByAirline('britishairways', 'bloqueio')
    await jobs.pauseAirlineForBlock('britishairways', new Date(Date.now() - 1000), 'bloqueio')

    const { rows } = await pool.query(`SELECT status, batch_id FROM ${SCHEMA}.scraping_jobs WHERE id = $1`, [id])
    expect(rows[0]).toMatchObject({ status: 'pending', batch_id: null })
    expect(await batches.claimBatch('britishairways', 1)).not.toBeNull()
  })

  it('item já coletado sai do lote na hora, sem esperar o fechamento', async () => {
    const id = await criaJob()
    await batches.claimBatch('britishairways', 1)

    await jobs.markSuccess(id, new Date(Date.now() + 3_600_000))

    const { rows } = await pool.query(`SELECT batch_id FROM ${SCHEMA}.scraping_jobs WHERE id = $1`, [id])
    expect(rows[0].batch_id).toBeNull()
  })

  it('dropItem baixa o esperado do lote — senão um item cancelado o segura aberto', async () => {
    await criaJob({ date: '2026-12-11' })
    await criaJob({ date: '2026-12-12' })
    const c = await batches.claimBatch('britishairways', 2)
    expect(c?.batch.item_count).toBe(2)

    const depois = await batches.dropItem(c!.batch.id)

    expect(depois?.item_count).toBe(1)
  })
})
