import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { ScrapingJobRepository } from '../scraping-jobs/ScrapingJobRepository'
import { AnalysisRunsRepository } from '../analysis-runs/AnalysisRunsRepository'

/**
 * Testa a única parte do reset que não cabe em mock: a exclusividade. Análises e
 * jobs são chaveados por ROTA, não por rotina, então duas rotinas que compartilham
 * trajeto e janela enxergam a MESMA linha. Apagar o que a outra rotina alcança
 * seria destruir dado alheio a partir de um botão de admin.
 *
 * Roda contra um Postgres real porque a decisão inteira vive no SQL (EXISTS
 * cruzando routines × routine_airlines). Pulado sem TEST_DATABASE_URL.
 *
 * Local:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test
 */

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'reset_analyses_it'

const A  = '00000000-0000-0000-0000-00000000000a'
const B  = '00000000-0000-0000-0000-00000000000b'
const RT = '00000000-0000-0000-0000-00000000000c'

const describeIt = DB_URL ? describe : describe.skip

describeIt('reset de análises — exclusividade por rota (integração / Postgres real)', () => {
  let pool: Pool
  let jobs: ScrapingJobRepository
  let runs: AnalysisRunsRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routines (
        id UUID PRIMARY KEY,
        origin VARCHAR(10) NOT NULL,
        destination VARCHAR(10) NOT NULL,
        outbound_start DATE NOT NULL,
        outbound_end   DATE NOT NULL,
        trip_type VARCHAR(20) NOT NULL DEFAULT 'one_way',
        inbound_start DATE,
        inbound_end   DATE
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routine_airlines (
        routine_id UUID NOT NULL,
        airline VARCHAR(20) NOT NULL,
        PRIMARY KEY (routine_id, airline)
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.scraping_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        airline VARCHAR(20) NOT NULL,
        origin VARCHAR(10) NOT NULL,
        destination VARCHAR(10) NOT NULL,
        flight_date DATE NOT NULL,
        return_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        retry_count INT NOT NULL DEFAULT 0,
        next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_success_at TIMESTAMPTZ,
        last_failure_at TIMESTAMPTZ,
        last_error TEXT,
        running_since TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        last_heartbeat_at TIMESTAMPTZ,
        request_id UUID,
        orphaned_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.analysis_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL,
        airline VARCHAR(20) NOT NULL,
        origin VARCHAR(10) NOT NULL,
        destination VARCHAR(10) NOT NULL,
        flight_date DATE NOT NULL,
        return_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'success',
        started_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.analysis_run_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        request_id UUID NOT NULL,
        seq INTEGER NOT NULL,
        type VARCHAR(30) NOT NULL DEFAULT 'log',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )`)

    jobs = new ScrapingJobRepository(pool)
    runs = new AnalysisRunsRepository(pool)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.routines, ${SCHEMA}.routine_airlines,
                               ${SCHEMA}.scraping_jobs, ${SCHEMA}.analysis_runs,
                               ${SCHEMA}.analysis_run_events`)

    // A e B dividem trajeto e companhia; as janelas se cruzam em 05→10/09.
    await pool.query(`
      INSERT INTO ${SCHEMA}.routines (id, origin, destination, outbound_start, outbound_end, trip_type, inbound_start, inbound_end)
      VALUES ($1, 'GRU', 'LIS', '2026-09-01', '2026-09-10', 'one_way',    NULL,         NULL),
             ($2, 'GRU', 'LIS', '2026-09-05', '2026-09-15', 'one_way',    NULL,         NULL),
             ($3, 'GRU', 'LIS', '2026-09-01', '2026-09-10', 'round_trip', '2026-09-20', '2026-09-25')`,
      [A, B, RT])
    await pool.query(`
      INSERT INTO ${SCHEMA}.routine_airlines (routine_id, airline)
      VALUES ($1, 'azul'), ($2, 'azul'), ($3, 'azul')`, [A, B, RT])
  })

  const addJob = (date: string, status = 'pending', returnDate: string | null = null) =>
    pool.query(
      `INSERT INTO ${SCHEMA}.scraping_jobs (airline, origin, destination, flight_date, return_date, status, retry_count, last_error)
       VALUES ('azul','GRU','LIS',$1,$2,$3,3,'boom')`,
      [date, returnDate, status])

  const addRun = (date: string, requestId: string, status = 'success', returnDate: string | null = null) =>
    pool.query(
      `INSERT INTO ${SCHEMA}.analysis_runs (request_id, airline, origin, destination, flight_date, return_date, status)
       VALUES ($1,'azul','GRU','LIS',$2,$3,$4)`,
      [requestId, date, returnDate, status])

  it('apaga a execução exclusiva e preserva a que a outra rotina também enxerga', async () => {
    const exclusive = '11111111-1111-1111-1111-111111111111'
    const shared    = '22222222-2222-2222-2222-222222222222'
    await addRun('2026-09-02', exclusive)            // só A alcança
    await addRun('2026-09-07', shared)               // A e B alcançam
    await pool.query(
      `INSERT INTO ${SCHEMA}.analysis_run_events (request_id, seq) VALUES ($1, 0), ($1, 1), ($2, 0)`,
      [exclusive, shared])

    const res = await runs.deleteExclusiveToRoutine(A)

    expect(res).toMatchObject({ runs: 1, events: 2, shared: 1 })
    const { rows } = await pool.query(`SELECT request_id FROM ${SCHEMA}.analysis_runs`)
    expect(rows.map((r) => r.request_id)).toEqual([shared])
    const { rows: evs } = await pool.query(`SELECT DISTINCT request_id FROM ${SCHEMA}.analysis_run_events`)
    expect(evs.map((r) => r.request_id)).toEqual([shared])
  })

  it('não toca em execução de fora da janela da rotina', async () => {
    await addRun('2026-09-12', '33333333-3333-3333-3333-333333333333') // só B alcança

    const res = await runs.deleteExclusiveToRoutine(A)

    expect(res.runs).toBe(0)
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.analysis_runs`)
    expect(rows[0].n).toBe(1)
  })

  it('execução em andamento fica — o callback do scraper ainda vai cair nela', async () => {
    await addRun('2026-09-02', '44444444-4444-4444-4444-444444444444', 'running')

    const res = await runs.deleteExclusiveToRoutine(A)

    expect(res).toMatchObject({ runs: 0, running: 1 })
  })

  it('job exclusivo volta ao zero; o compartilhado fica intacto', async () => {
    await addJob('2026-09-02')
    await addJob('2026-09-07')

    const res = await jobs.resetExclusiveToRoutine(A)

    expect(res).toMatchObject({ reset: 1, shared: 1 })
    const { rows } = await pool.query(
      `SELECT flight_date::text, status, retry_count, last_error FROM ${SCHEMA}.scraping_jobs ORDER BY flight_date`)
    expect(rows[0]).toMatchObject({ flight_date: '2026-09-02', status: 'pending', retry_count: 0, last_error: null })
    expect(rows[1]).toMatchObject({ flight_date: '2026-09-07', retry_count: 3, last_error: 'boom' })
  })

  it('job em execução não é resetado — o worker está no meio do scrape', async () => {
    await addJob('2026-09-02', 'running')

    const res = await jobs.resetExclusiveToRoutine(A)

    expect(res).toMatchObject({ reset: 0, running: 1 })
    const { rows } = await pool.query(`SELECT retry_count FROM ${SCHEMA}.scraping_jobs`)
    expect(rows[0].retry_count).toBe(3)
  })

  it('job one-way não pertence a rotina round-trip, e vice-versa', async () => {
    await addJob('2026-09-02', 'pending', null)          // one-way: A sim, RT não
    await addJob('2026-09-02', 'pending', '2026-09-22')  // par: RT sim, A não

    const resRt = await jobs.resetExclusiveToRoutine(RT)
    expect(resRt).toMatchObject({ reset: 1, shared: 0 })

    const { rows } = await pool.query(
      `SELECT return_date::text, retry_count FROM ${SCHEMA}.scraping_jobs ORDER BY return_date NULLS FIRST`)
    expect(rows[0]).toMatchObject({ return_date: null, retry_count: 3 })
    expect(rows[1]).toMatchObject({ return_date: '2026-09-22', retry_count: 0 })
  })
})
