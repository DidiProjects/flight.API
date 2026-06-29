import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { TargetAlertStateRepository } from './TargetAlertStateRepository'

// Testa o coração do anti-repetição do alerta 'target': o upsert monotônico-
// descendente com RETURNING (só as datas que de fato avançaram). Roda contra um
// Postgres real porque a lógica vive no SQL (ON CONFLICT ... WHERE + RETURNING).
// Pulado quando TEST_DATABASE_URL não está definido — o CI sobe o Postgres.
//
// Local:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'target_alert_state_it'

const ROUTINE = '00000000-0000-0000-0000-0000000000aa'
const OTHER   = '00000000-0000-0000-0000-0000000000bb'

const describeIt = DB_URL ? describe : describe.skip

describeIt('TargetAlertStateRepository (integração / Postgres real)', () => {
  let pool: Pool
  let repo: TargetAlertStateRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    // Espelha o schema real (sem a FK para routines, self-contained).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.target_alert_state (
        routine_id       UUID          NOT NULL,
        flight_date      DATE          NOT NULL,
        fare_type        VARCHAR(10)   NOT NULL,
        notified_amount  NUMERIC(12,2) NOT NULL,
        notified_airline VARCHAR(20),
        notified_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
        PRIMARY KEY (routine_id, flight_date, fare_type)
      )
    `)
    repo = new TargetAlertStateRepository(pool)
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await pool.end()
    }
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.target_alert_state`)
  })

  it('primeira gravação — todas as datas voltam como avançadas e viram watermark', async () => {
    const advanced = await repo.recordNotified(ROUTINE, 'cash', [
      { flightDate: '2027-02-22', amount: 3350, airline: 'britishairways' },
      { flightDate: '2027-02-25', amount: 3100, airline: 'latam' },
    ])
    expect([...advanced].sort()).toEqual(['2027-02-22', '2027-02-25'])

    const wm = await repo.getWatermarks(ROUTINE, 'cash')
    expect(wm.get('2027-02-22')).toBe(3350)
    expect(wm.get('2027-02-25')).toBe(3100)
  })

  it('mesmo preço re-gravado — não avança (à prova de corrida entre ciclos)', async () => {
    await repo.recordNotified(ROUTINE, 'cash', [{ flightDate: '2027-02-22', amount: 3350, airline: 'azul' }])

    const advanced = await repo.recordNotified(ROUTINE, 'cash', [{ flightDate: '2027-02-22', amount: 3350, airline: 'azul' }])
    expect(advanced.size).toBe(0)
  })

  it('preço maior — não avança e não sobe o watermark', async () => {
    await repo.recordNotified(ROUTINE, 'cash', [{ flightDate: '2027-02-22', amount: 3350, airline: 'azul' }])

    const advanced = await repo.recordNotified(ROUTINE, 'cash', [{ flightDate: '2027-02-22', amount: 3500, airline: 'azul' }])
    expect(advanced.size).toBe(0)

    const wm = await repo.getWatermarks(ROUTINE, 'cash')
    expect(wm.get('2027-02-22')).toBe(3350) // inalterado
  })

  it('preço menor — avança e rebaixa o watermark', async () => {
    await repo.recordNotified(ROUTINE, 'cash', [{ flightDate: '2027-02-22', amount: 3350, airline: 'azul' }])

    const advanced = await repo.recordNotified(ROUTINE, 'cash', [{ flightDate: '2027-02-22', amount: 3100, airline: 'latam' }])
    expect([...advanced]).toEqual(['2027-02-22'])

    const wm = await repo.getWatermarks(ROUTINE, 'cash')
    expect(wm.get('2027-02-22')).toBe(3100)
  })

  it('lote misto — só as datas que melhoraram voltam no RETURNING', async () => {
    await repo.recordNotified(ROUTINE, 'cash', [
      { flightDate: '2027-02-22', amount: 3350, airline: 'azul' },
      { flightDate: '2027-02-25', amount: 3100, airline: 'azul' },
    ])

    const advanced = await repo.recordNotified(ROUTINE, 'cash', [
      { flightDate: '2027-02-22', amount: 3000, airline: 'latam' }, // melhora
      { flightDate: '2027-02-25', amount: 3200, airline: 'azul' },  // piora → corta
      { flightDate: '2027-02-28', amount: 4000, airline: 'azul' },  // nova → entra
    ])
    expect([...advanced].sort()).toEqual(['2027-02-22', '2027-02-28'])

    const wm = await repo.getWatermarks(ROUTINE, 'cash')
    expect(wm.get('2027-02-22')).toBe(3000)
    expect(wm.get('2027-02-25')).toBe(3100) // inalterado
    expect(wm.get('2027-02-28')).toBe(4000)
  })

  it('getWatermarks isola por rotina e por tipo de tarifa', async () => {
    await repo.recordNotified(ROUTINE, 'cash', [{ flightDate: '2027-02-22', amount: 3350, airline: 'azul' }])
    await repo.recordNotified(OTHER,   'cash', [{ flightDate: '2027-02-22', amount: 9999, airline: 'azul' }])
    await repo.recordNotified(ROUTINE, 'pts',  [{ flightDate: '2027-02-22', amount: 50000, airline: 'azul' }])

    const wm = await repo.getWatermarks(ROUTINE, 'cash')
    expect(wm.size).toBe(1)
    expect(wm.get('2027-02-22')).toBe(3350)
  })

  it('cleanupPastDates remove só datas passadas', async () => {
    await pool.query(
      `INSERT INTO ${SCHEMA}.target_alert_state (routine_id, flight_date, fare_type, notified_amount)
       VALUES ($1, CURRENT_DATE - 1, 'cash', 100),
              ($1, CURRENT_DATE + 30, 'cash', 200)`,
      [ROUTINE],
    )

    const removed = await repo.cleanupPastDates()
    expect(removed).toBe(1)

    const wm = await repo.getWatermarks(ROUTINE, 'cash')
    expect(wm.size).toBe(1) // só a futura sobrou
  })
})
