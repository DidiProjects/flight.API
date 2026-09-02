import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { RoutinesRepository } from './RoutinesRepository'

/**
 * The row must be what its type says it is.
 *
 * `RoutineRow` declares `margin: number`, but `pg` returns NUMERIC as a STRING and
 * TypeScript cannot see it: `db.query<RoutineRow>` is an assertion, not a check. The
 * lie reached `const t = 1 + routine.margin`, where `1 + "0.100"` CONCATENATES into
 * `"10.100"` and the target ceiling came out ten times too high — a routine aiming
 * at R$7,000 alerted on R$8,374.95 in production on 2026-08-31.
 *
 * This runs against a real Postgres on purpose: the defect IS the driver's
 * behaviour, so a mocked pool would return the numbers we already believe in and
 * prove nothing. Skipped without TEST_DATABASE_URL.
 *
 * Locally:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test
 */

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'routines_numeric_it'
const USER = '00000000-0000-0000-0000-0000000000a1'
const ROUTINE = '00000000-0000-0000-0000-0000000000a2'

const describeIt = DB_URL ? describe : describe.skip

describeIt('RoutinesRepository — NUMERIC volta como número (integração / Postgres real)', () => {
  let pool: Pool
  let repo: RoutinesRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routines (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        name VARCHAR(100) NOT NULL,
        origin CHAR(3) NOT NULL,
        destination CHAR(3) NOT NULL,
        outbound_start DATE NOT NULL,
        outbound_end   DATE NOT NULL,
        trip_type VARCHAR(20) NOT NULL DEFAULT 'round_trip',
        inbound_start DATE,
        inbound_end   DATE,
        passengers SMALLINT NOT NULL DEFAULT 1,
        currency VARCHAR(3),
        target_cash NUMERIC(10,2),
        target_pts INTEGER,
        target_hyb_pts INTEGER,
        target_hyb_cash NUMERIC(10,2),
        margin NUMERIC(4,3) NOT NULL DEFAULT 0.1,
        priority VARCHAR(10) NOT NULL DEFAULT 'cash',
        notification_modes TEXT[] NOT NULL DEFAULT '{target}',
        notification_frequency VARCHAR(10) NOT NULL DEFAULT 'daily',
        scheduled_time TIME,
        cc_emails JSONB NOT NULL DEFAULT '[]',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routine_airlines (
        routine_id UUID NOT NULL,
        airline VARCHAR(20) NOT NULL,
        PRIMARY KEY (routine_id, airline)
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routine_pending_requests (
        routine_id UUID NOT NULL,
        airline VARCHAR(20) NOT NULL,
        request_id UUID,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (routine_id, airline)
      )`)

    await pool.query(`DELETE FROM ${SCHEMA}.routine_airlines`)
    await pool.query(`DELETE FROM ${SCHEMA}.routines`)
    // Os mesmos valores da rotina "Natal no Brasil" que gerou o alerta indevido.
    await pool.query(`
      INSERT INTO ${SCHEMA}.routines
        (id, user_id, name, origin, destination, outbound_start, outbound_end,
         inbound_start, inbound_end, target_cash, target_hyb_cash, margin, passengers)
      VALUES ($1, $2, 'Natal no Brasil', 'LHR', 'GRU', '2026-12-05', '2026-12-20',
              '2027-01-03', '2027-01-10', 7000.00, 500.00, 0.100, 2)`,
      [ROUTINE, USER])
    await pool.query(
      `INSERT INTO ${SCHEMA}.routine_airlines (routine_id, airline) VALUES ($1,'britishairways')`,
      [ROUTINE])

    repo = new RoutinesRepository(pool)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  it('o driver realmente devolve NUMERIC como string — é isso que o hydrate existe para corrigir', async () => {
    const { rows } = await pool.query(`SELECT margin, target_cash FROM ${SCHEMA}.routines WHERE id = $1`, [ROUTINE])
    // Se um dia o pg passar a converter sozinho, este teste avisa e o hydrate vira redundante.
    expect(typeof rows[0].margin).toBe('string')
    expect(typeof rows[0].target_cash).toBe('string')
  })

  it('findByIdAdmin devolve margin e alvos como number', async () => {
    const r = await repo.findByIdAdmin(ROUTINE)
    expect(r).not.toBeNull()
    expect(typeof r!.margin).toBe('number')
    expect(r!.margin).toBe(0.1)
    expect(typeof r!.target_cash).toBe('number')
    expect(r!.target_cash).toBe(7000)
    expect(typeof r!.target_hyb_cash).toBe('number')
    expect(typeof r!.passengers).toBe('number')
  })

  it('o teto do alvo volta a ser 7.700 — a soma não concatena mais', async () => {
    const r = await repo.findByIdAdmin(ROUTINE)
    const t = 1 + r!.margin
    expect(t).toBe(1.1)
    const teto = r!.target_cash! * t
    // Era 70.700 com a string. O par real de R$8.374,95 tem de ficar de fora.
    expect(teto).toBeCloseTo(7700, 2)
    expect(8374.95 <= teto).toBe(false)
  })

  it('alvo ausente continua nulo, não vira zero', async () => {
    const r = await repo.findByIdAdmin(ROUTINE)
    expect(r!.target_pts).toBeNull()
    expect(r!.target_hyb_pts).toBeNull()
  })

  it('findAllActive e findActiveForScheduled também hidratam', async () => {
    const ativas = await repo.findAllActive()
    expect(ativas.length).toBeGreaterThan(0)
    expect(ativas.every((r) => typeof r.margin === 'number')).toBe(true)

    const dispatch = await repo.findDispatchable()
    expect(dispatch.every((r) => typeof r.margin === 'number')).toBe(true)
  })
})
