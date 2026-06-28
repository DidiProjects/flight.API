import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { FlightFaresRepository } from './FlightFaresRepository'
import type { FlightFareRow } from './interfaces/IFlightFaresRepository'

// Teste de regressão do CONGELAMENTO de tarifas (preço/scraped_at parados na
// primeira coleta). Roda contra um Postgres real porque o bug vivia no SQL
// (chave do ON CONFLICT + join de "snapshot mais recente"). É pulado quando
// TEST_DATABASE_URL não está definido — o CI sobe um Postgres e define a var.
//
// Para rodar local:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'flight_fares_it'

// Mesmo job (rota), execuções diferentes — exatamente o cenário de produção:
// scraping_jobs é por rota (permanente), cada coleta tem seu próprio request_id.
const JOB_ID = '00000000-0000-0000-0000-0000000000aa'
const REQ_1  = '11111111-1111-1111-1111-111111111111'
const REQ_2  = '22222222-2222-2222-2222-222222222222'

type FareInput = Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'request_id' | 'scraped_at'>

function fare(flightNumber: string, fareCash: number): FareInput {
  return {
    flight_number:  flightNumber,
    flight_date:    '2026-07-12',
    is_return:      false,
    origin:         'CNF',
    destination:    'VCP',
    airline:        'azul',
    departure_time: '08:00',
    arrival_time:   '09:30',
    duration_min:   90,
    stops:          0,
    currency:       'BRL',
    fare_cash:      fareCash,
    fare_pts:       null,
    fare_hyb_pts:   null,
    fare_hyb_cash:  null,
  }
}

const describeIt = DB_URL ? describe : describe.skip

describeIt('FlightFaresRepository (integração / Postgres real)', () => {
  let pool: Pool
  let repo: FlightFaresRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    // Espelha o schema real relevante (sem FKs, para ser self-contained) +
    // o índice único corrigido (request_id como discriminador de execução).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.flight_fares (
        id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        scraping_job_id  UUID          NOT NULL,
        request_id       UUID,
        flight_number    VARCHAR(20),
        flight_date      DATE          NOT NULL,
        is_return        BOOLEAN       NOT NULL DEFAULT FALSE,
        origin           VARCHAR(10)   NOT NULL,
        destination      VARCHAR(10)   NOT NULL,
        airline          VARCHAR(20)   NOT NULL,
        departure_time   TIME,
        arrival_time     TIME,
        duration_min     INT,
        stops            INT,
        currency         VARCHAR(3),
        fare_cash        NUMERIC(10,2),
        fare_pts         NUMERIC(10,0),
        fare_hyb_pts     NUMERIC(10,0),
        fare_hyb_cash    NUMERIC(10,2),
        scraped_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_flight_fares_no_dup
        ON ${SCHEMA}.flight_fares(request_id, flight_date, is_return, flight_number)
        WHERE flight_number IS NOT NULL AND request_id IS NOT NULL
    `)
    repo = new FlightFaresRepository(pool)
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await pool.end()
    }
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.flight_fares`)
  })

  async function countRows(): Promise<number> {
    const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${SCHEMA}.flight_fares`)
    return Number(rows[0].c)
  }

  it('REGRESSÃO: re-coleta da MESMA rota (mesmo scraping_job_id) grava um snapshot NOVO', async () => {
    // 1ª coleta da rota.
    const inserted1 = await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05), fare('AD4096', 1178.91)])
    expect(inserted1).toBe(2)

    // garante scraped_at estritamente maior na 2ª coleta
    await new Promise((r) => setTimeout(r, 15))

    // 2ª coleta — MESMO job, MESMOS voos, preços novos. Antes da correção
    // (ON CONFLICT em scraping_job_id) isto retornava 0 e o snapshot era
    // descartado, congelando preço/scraped_at na 1ª coleta. Agora insere.
    const inserted2 = await repo.insertMany(JOB_ID, REQ_2, [fare('AD4188', 500.00), fare('AD4096', 600.00)])
    expect(inserted2).toBe(2)

    // Histórico preservado: 4 linhas (2 snapshots), não 2.
    expect(await countRows()).toBe(4)
  })

  it('REGRESSÃO: getCurrentBest reflete a coleta MAIS RECENTE, não a congelada', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05), fare('AD4096', 1178.91)])
    await new Promise((r) => setTimeout(r, 15))
    await repo.insertMany(JOB_ID, REQ_2, [fare('AD4188', 500.00), fare('AD4096', 600.00)])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-12', '2026-07-12')

    // Menor preço da ÚLTIMA execução (500), não o mínimo histórico de tudo.
    expect(Number(current.best_cash)).toBe(500)
    // scraped_at é o da 2ª coleta (não o congelado da 1ª).
    expect(current.scraped_at).not.toBeNull()
    const { rows } = await pool.query<{ max: Date; min: Date }>(
      `SELECT max(scraped_at) AS max, min(scraped_at) AS min FROM ${SCHEMA}.flight_fares`,
    )
    expect(new Date(current.scraped_at as unknown as string).getTime())
      .toBe(new Date(rows[0].max).getTime())
    expect(new Date(rows[0].max).getTime()).toBeGreaterThan(new Date(rows[0].min).getTime())
  })

  it('getPriceByDate usa o snapshot da execução mais recente por data', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05), fare('AD4096', 1178.91)])
    await new Promise((r) => setTimeout(r, 15))
    await repo.insertMany(JOB_ID, REQ_2, [fare('AD4188', 500.00), fare('AD4096', 600.00)])

    const byDate = await repo.getPriceByDate(['azul'], 'CNF', 'VCP', '2026-07-12', '2026-07-12')
    expect(byDate).toHaveLength(1)
    expect(Number(byDate[0].best_cash)).toBe(500)
  })

  it('idempotência: callback re-entregue (mesmo request_id) não duplica nem altera', async () => {
    const first = await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05)])
    expect(first).toBe(1)

    // Mesma execução reentregue: ON CONFLICT (request_id, ...) protege.
    const replay = await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05)])
    expect(replay).toBe(0)
    expect(await countRows()).toBe(1)
  })
})
