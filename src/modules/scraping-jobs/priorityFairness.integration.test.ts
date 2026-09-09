import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { ScrapingJobRepository } from './ScrapingJobRepository'

/**
 * The routine-fairness term of `updatePriorities`.
 *
 * Against a real Postgres because the whole thing is one SQL expression — the
 * correlated MAX over `job_routine_membership`, the COALESCE to the routine's
 * `created_at`, the cap and the weight. A mock would assert we ran a query, not
 * that a wide routine stops out-ranking a narrow one once it gets a dispatch.
 *
 * Skipped without TEST_DATABASE_URL.
 */

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'priority_fairness_it'

const describeIt = DB_URL ? describe : describe.skip

describeIt('justiça por rotina em updatePriorities (integração / Postgres real)', () => {
  let pool: Pool
  let jobs: ScrapingJobRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.scraping_jobs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        airline         VARCHAR(20) NOT NULL,
        origin          VARCHAR(10) NOT NULL,
        destination     VARCHAR(10) NOT NULL,
        flight_date     DATE NOT NULL,
        return_date     DATE,
        status          VARCHAR(20) NOT NULL DEFAULT 'pending',
        priority        INT NOT NULL DEFAULT 0,
        last_success_at TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routines (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        is_active      BOOLEAN NOT NULL DEFAULT true,
        origin         CHAR(3) NOT NULL,
        destination    CHAR(3) NOT NULL,
        trip_type      VARCHAR(20) NOT NULL DEFAULT 'one_way',
        outbound_start DATE NOT NULL,
        outbound_end   DATE NOT NULL,
        inbound_start  DATE,
        inbound_end    DATE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routine_airlines (
        routine_id UUID NOT NULL,
        airline    VARCHAR(20) NOT NULL,
        PRIMARY KEY (routine_id, airline)
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routine_airline_dispatch (
        routine_id         UUID NOT NULL,
        airline            VARCHAR(20) NOT NULL,
        last_dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (routine_id, airline)
      )`)
    await pool.query(`
      CREATE OR REPLACE VIEW ${SCHEMA}.job_routine_membership AS
      SELECT j.id AS job_id, r.id AS routine_id
        FROM ${SCHEMA}.scraping_jobs j
        JOIN ${SCHEMA}.routine_airlines ra ON ra.airline = j.airline
        JOIN ${SCHEMA}.routines        r  ON r.id = ra.routine_id
       WHERE r.is_active = true
         AND r.origin = j.origin AND r.destination = j.destination
         AND j.flight_date BETWEEN r.outbound_start AND r.outbound_end
         AND (
              (j.return_date IS NULL     AND r.trip_type = 'one_way')
           OR (j.return_date IS NOT NULL AND r.trip_type = 'round_trip'
               AND j.return_date BETWEEN r.inbound_start AND r.inbound_end)
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
    await pool.query(`TRUNCATE ${SCHEMA}.scraping_jobs, ${SCHEMA}.routines, ${SCHEMA}.routine_airlines, ${SCHEMA}.routine_airline_dispatch`)
  })

  // A one-way routine covering [today+20, today+20+span] on one airline, created `ageH` ago.
  const criaRotina = async (span: number, ageH: number): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.routines (origin, destination, outbound_start, outbound_end, created_at)
       VALUES ('CNF', 'GRU', CURRENT_DATE + 20, CURRENT_DATE + 20 + $1::int, now() - ($2 || ' hours')::interval)
       RETURNING id`,
      [span, ageH],
    )
    const id = rows[0]!.id
    await pool.query(`INSERT INTO ${SCHEMA}.routine_airlines (routine_id, airline) VALUES ($1, 'gol')`, [id])
    return id
  }

  const criaJobs = async (n: number): Promise<string[]> => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ${SCHEMA}.scraping_jobs (airline, origin, destination, flight_date)
         VALUES ('gol', 'CNF', 'GRU', CURRENT_DATE + 20 + $1::int) RETURNING id`,
        [i],
      )
      ids.push(rows[0]!.id)
    }
    return ids
  }

  const dispatchedHoursAgo = (routineId: string, h: number) =>
    pool.query(
      `INSERT INTO ${SCHEMA}.routine_airline_dispatch (routine_id, airline, last_dispatched_at)
       VALUES ($1, 'gol', now() - ($2 || ' hours')::interval)`,
      [routineId, h],
    )

  const priorityOf = async (jobId: string): Promise<number> => {
    const { rows } = await pool.query<{ priority: number }>(
      `SELECT priority FROM ${SCHEMA}.scraping_jobs WHERE id = $1`, [jobId],
    )
    return rows[0]!.priority
  }

  it('peso 0 reproduz o comportamento anterior: só staleness + proximidade', async () => {
    const r = await criaRotina(0, 200)
    const [job] = await criaJobs(1)
    await dispatchedHoursAgo(r, 100)   // faminta há muito — daria bônus cheio se peso > 0

    await jobs.updatePriorities(0, 48)

    // flight_date = hoje + 20 → bucket proximidade 60 * 0.4 = 24; staleness ~0.
    expect(await priorityOf(job)).toBe(24)
  })

  it('com peso, o job da rotina faminta supera o da rotina recém-despachada', async () => {
    const faminta = await criaRotina(0, 300)
    const [jFaminta] = await criaJobs(1)
    // a "recém" cobre outra rota, para não compartilhar o mesmo job
    const recente = await criaRotina(0, 300)
    await pool.query(`UPDATE ${SCHEMA}.routines SET destination = 'GIG' WHERE id = $1`, [recente])
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.scraping_jobs (airline, origin, destination, flight_date)
       VALUES ('gol', 'CNF', 'GIG', CURRENT_DATE + 20) RETURNING id`,
    )
    const jRecente = rows[0]!.id
    await dispatchedHoursAgo(faminta, 72)   // além do cap de 48h → bônus cheio
    await dispatchedHoursAgo(recente, 0)

    await jobs.updatePriorities(40, 48)

    expect(await priorityOf(jFaminta)).toBeGreaterThan(await priorityOf(jRecente))
    expect(await priorityOf(jFaminta) - await priorityOf(jRecente)).toBe(40)
  })

  it('rotina larga recém-despachada não passa na frente de uma rotina estreita faminta', async () => {
    const larga = await criaRotina(4, 500)          // 5 células
    const largaJobs = await criaJobs(5)
    const estreita = await criaRotina(0, 500)       // 1 célula, outra rota
    await pool.query(`UPDATE ${SCHEMA}.routines SET destination = 'GIG' WHERE id = $1`, [estreita])
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.scraping_jobs (airline, origin, destination, flight_date)
       VALUES ('gol', 'CNF', 'GIG', CURRENT_DATE + 20) RETURNING id`,
    )
    const jEstreita = rows[0]!.id

    // a larga acabou de rodar; a estreita nunca rodou (só o created_at conta)
    await dispatchedHoursAgo(larga, 0)

    await jobs.updatePriorities(40, 48)

    const pEstreita = await priorityOf(jEstreita)
    for (const j of largaJobs) {
      expect(pEstreita).toBeGreaterThan(await priorityOf(j))
    }
  })

  it('stampRoutineDispatch carimba todas as rotinas que o job atende', async () => {
    const r1 = await criaRotina(2, 10)
    const r2 = await criaRotina(2, 10)   // mesma rota+janela → ambas atendem o job
    const [job] = await criaJobs(1)

    await jobs.stampRoutineDispatch('gol', [job])

    const { rows } = await pool.query<{ routine_id: string }>(
      `SELECT routine_id FROM ${SCHEMA}.routine_airline_dispatch WHERE airline = 'gol'`,
    )
    expect(rows.map((r) => r.routine_id).sort()).toEqual([r1, r2].sort())
  })

  it('stampRoutineDispatch é idempotente: reexecutar só adianta o last_dispatched_at', async () => {
    const r = await criaRotina(0, 10)
    const [job] = await criaJobs(1)
    await dispatchedHoursAgo(r, 5)

    await jobs.stampRoutineDispatch('gol', [job])

    const { rows } = await pool.query<{ recent: boolean }>(
      `SELECT last_dispatched_at > now() - interval '1 minute' AS recent
         FROM ${SCHEMA}.routine_airline_dispatch WHERE routine_id = $1`, [r],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.recent).toBe(true)
  })
})
