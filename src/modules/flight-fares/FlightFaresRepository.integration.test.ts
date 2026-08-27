import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { FlightFaresRepository } from './FlightFaresRepository'
import type { FlightFareRow } from './interfaces/IFlightFaresRepository'

// Regression test for fare FREEZING (price/scraped_at stuck at the first
// collection). Runs against a real Postgres because the bug lived in the SQL
// (ON CONFLICT key + the "most recent snapshot" join). Skipped when
// TEST_DATABASE_URL is unset — CI starts a Postgres and sets the var.
//
// To run locally:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'flight_fares_it'

/** A DATE column comes back from pg as Date; normalise to YYYY-MM-DD. */
function toDateStr(v: string | Date): string {
  return v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10)
}

// Same job (route), different runs — exactly the production scenario:
// scraping_jobs is per route (permanent), each collection has its own request_id.
const JOB_ID = '00000000-0000-0000-0000-0000000000aa'
const REQ_1  = '11111111-1111-1111-1111-111111111111'
const REQ_2  = '22222222-2222-2222-2222-222222222222'

type FareInput = Omit<FlightFareRow, 'id' | 'scraping_job_id' | 'request_id' | 'scraped_at'>

function fare(flightNumber: string, fareCash: number, over: Partial<FareInput> = {}): FareInput {
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
    // A fare in Real needs no quote: the value is itself and the rate is 1.
    // That is what 017 writes on ingestion, and what the pair sums read.
    fare_cash_brl:     fareCash,
    fare_hyb_cash_brl: null,
    fx_rate:           1,
    fx_rate_date:      '2026-07-12',
    return_date:            null,
    paired_outbound_flight: null,
    inbound_unavailable:    false,
    ...over,
  }
}

/**
 * Leg of a round-trip pair.
 *
 * The return has `flight_date` equal to ITS date (the return date) and not the
 * outbound's — that is the shape the scraper really writes, and what the pair
 * SQL has to match by request_id.
 */
function pairLeg(o: {
  flight: string; cash: number; outDate: string; retDate: string;
  isReturn: boolean; pairedTo?: string | null; inboundUnavailable?: boolean;
}): FareInput {
  return fare(o.flight, o.cash, {
    flight_date: o.isReturn ? o.retDate : o.outDate,
    is_return:   o.isReturn,
    origin:      o.isReturn ? 'VCP' : 'CNF',
    destination: o.isReturn ? 'CNF' : 'VCP',
    return_date: o.retDate,
    paired_outbound_flight: o.pairedTo ?? null,
    inbound_unavailable:    o.inboundUnavailable ?? false,
  })
}

const describeIt = DB_URL ? describe : describe.skip

describeIt('FlightFaresRepository (integração / Postgres real)', () => {
  let pool: Pool
  let repo: FlightFaresRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    // Mirrors the relevant real schema (no FKs, to stay self-contained) plus
    // the corrected unique index (request_id as the run discriminator).
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
        fare_cash_brl     NUMERIC(12,2),
        fare_hyb_cash_brl NUMERIC(12,2),
        fx_rate           NUMERIC(18,8),
        fx_rate_date      DATE,
        return_date      DATE,
        paired_outbound_flight VARCHAR(20),
        inbound_unavailable    BOOLEAN NOT NULL DEFAULT FALSE,
        bundle_cash      NUMERIC(10,2),
        bundle_pts       NUMERIC(10,0),
        bundle_hyb_pts   NUMERIC(10,0),
        bundle_hyb_cash  NUMERIC(10,2),
        scraped_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `)
    // The current-price queries exclude dates whose job died. Without this table
    // in the test schema, `search_path` would fall back to public and the
    // predicate would be answered by the development bank.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.scraping_jobs (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        airline     VARCHAR(20) NOT NULL,
        origin      VARCHAR(10) NOT NULL,
        destination VARCHAR(10) NOT NULL,
        flight_date DATE        NOT NULL,
        return_date DATE,
        status      VARCHAR(20) NOT NULL DEFAULT 'pending',
        retry_count INT         NOT NULL DEFAULT 0,
        max_retries INT         NOT NULL DEFAULT 3
      )
    `)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_flight_fares_no_dup
        ON ${SCHEMA}.flight_fares(request_id, flight_date, is_return, flight_number, paired_outbound_flight)
        NULLS NOT DISTINCT
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
    await pool.query(`TRUNCATE ${SCHEMA}.flight_fares, ${SCHEMA}.scraping_jobs`)
  })

  /** Backdates a collection, to age a snapshot without waiting for the clock. */
  const envelhecer = (requestId: string, horas: number) =>
    pool.query(
      `UPDATE ${SCHEMA}.flight_fares SET scraped_at = NOW() - ($2 || ' hours')::interval WHERE request_id = $1`,
      [requestId, horas])

  const matarJob = (flightDate: string) =>
    pool.query(
      `INSERT INTO ${SCHEMA}.scraping_jobs (airline, origin, destination, flight_date, status, retry_count)
       VALUES ('azul','CNF','VCP',$1,'dead',3)`,
      [flightDate])

  async function countRows(): Promise<number> {
    const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${SCHEMA}.flight_fares`)
    return Number(rows[0].c)
  }

  it('REGRESSÃO: re-coleta da MESMA rota (mesmo scraping_job_id) grava um snapshot NOVO', async () => {
    // First collection of the route.
    const inserted1 = await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05), fare('AD4096', 1178.91)])
    expect(inserted1).toBe(2)

    // guarantees a strictly greater scraped_at on the second collection
    await new Promise((r) => setTimeout(r, 15))

    // Second collection — SAME job, SAME flights, new prices. Before the fix
    // (ON CONFLICT on scraping_job_id) this returned 0 and the snapshot was
    // discarded, freezing price/scraped_at at the first collection. Now it inserts.
    const inserted2 = await repo.insertMany(JOB_ID, REQ_2, [fare('AD4188', 500.00), fare('AD4096', 600.00)])
    expect(inserted2).toBe(2)

    // History preserved: 4 rows (2 snapshots), not 2.
    expect(await countRows()).toBe(4)
  })

  it('REGRESSÃO: getCurrentBest reflete a coleta MAIS RECENTE, não a congelada', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05), fare('AD4096', 1178.91)])
    await new Promise((r) => setTimeout(r, 15))
    await repo.insertMany(JOB_ID, REQ_2, [fare('AD4188', 500.00), fare('AD4096', 600.00)])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-12', '2026-07-12')

    // Lowest price of the LAST run (500), not the all-time historical minimum.
    expect(Number(current.best_cash)).toBe(500)
    // scraped_at is the second collection (not the frozen first).
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

    // Same run delivered again: ON CONFLICT (request_id, ...) protects.
    const replay = await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 702.05)])
    expect(replay).toBe(0)
    expect(await countRows()).toBe(1)
  })

  // ── round-trip pair (1-to-N) ────────────────────────────────────────────────

  const OUT = '2026-07-12'
  const RET = '2026-07-20'

  it('REGRESSÃO: as duas pernas do par caem no MESMO grupo', async () => {
    // The bug: the pair was matched by flight_date, but the return carries ITS date.
    // The legs went to different groups and EVERY real pair was discarded as
    // incomplete — RT evaluation never produced a total.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 566.28, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])

    const rows = await repo.getLatestPairs('azul', 'CNF', 'VCP', OUT, OUT, RET, RET)

    expect(rows).toHaveLength(2)
    // Both legs share the pair identity and the outbound date.
    expect(new Set(rows.map((r) => r.request_id)).size).toBe(1)
    expect(rows.map((r) => toDateStr(r.pair_outbound_date))).toEqual([OUT, OUT])
    // The return still carries ITS date — which is exactly why flight_date does
    // not work for grouping the pair.
    const inbound = rows.find((r) => r.is_return)!
    expect(toDateStr(inbound.flight_date)).toBe(RET)
  })

  it('a mesma volta sob idas diferentes sobrevive ao dedup', async () => {
    // This is the mechanism of the RT discount: the AD900 return costs differently
    // depending on the chosen outbound. Without paired_outbound_flight in the
    // unique key, ON CONFLICT would keep only the first and 1-to-N would have no data.
    const inserted = await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD200', cash: 500.00, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 566.28, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
      pairLeg({ flight: 'AD900', cash: 300.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD200' }),
    ])

    expect(inserted).toBe(4)
    const rows = await repo.getLatestPairs('azul', 'CNF', 'VCP', OUT, OUT, RET, RET)
    const ad900 = rows.filter((r) => r.flight_number === 'AD900')
    expect(ad900).toHaveLength(2)
    expect(new Set(ad900.map((r) => r.paired_outbound_flight))).toEqual(new Set(['AD100', 'AD200']))
  })

  it('getCurrentBest do par soma a ida com a volta DELA', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD200', cash: 500.00, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 566.28, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
      pairLeg({ flight: 'AD901', cash: 300.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD200' }),
    ])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    // 500 + 300 = 800 beats 365.45 + 566.28 = 931.73. The forbidden crossing
    // (365.45 + 300) would give 665.45 — a pair the airline never offered.
    expect(Number(current.best_cash)).toBe(800)
    expect(current.inbound_unavailable).toBe(false)

    // The displayed parts must be those of the WINNING pair. Taking the lowest out
    // and the lowest in separately would return 365.45 / 300 — that inexistent pair.
    expect(Number(current.best_cash_outbound)).toBe(500)
    expect(Number(current.best_cash_inbound)).toBe(300)
    expect(
      Number(current.best_cash_outbound) + Number(current.best_cash_inbound),
    ).toBe(Number(current.best_cash))
  })

  it('coleta só com as idas não apaga a melhor tarifa da coleta completa anterior', async () => {
    // The 1-to-N loop trips on the first outbound and the job ends as `success`
    // carrying outbounds only. Before, that collection won the DISTINCT ON for
    // being the most recent and every total came out NULL — the routine lost the
    // best fare it had, without saying why.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])
    await new Promise((r) => setTimeout(r, 15))
    await repo.insertMany(JOB_ID, REQ_2, [
      pairLeg({ flight: 'AD100', cash: 200.00, outDate: OUT, retDate: RET, isReturn: false }),
    ])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    expect(Number(current.best_cash)).toBe(665.45)
  })

  it('coleta completa mais recente continua mandando na anterior', async () => {
    // The counterpart of the test above: the filter elects the most recent run
    // that resolved the return, not the OLDEST. Without it the price would freeze.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])
    await new Promise((r) => setTimeout(r, 15))
    await repo.insertMany(JOB_ID, REQ_2, [
      pairLeg({ flight: 'AD100', cash: 100.00, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 150.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    expect(Number(current.best_cash)).toBe(250)
  })

  it('volta indefinida mais recente vence: o motivo conhecido não é coleta truncada', async () => {
    // `inbound_unavailable` is a KNOWN limitation (TudoAzul login): the routine
    // shows "—" with a reason. Showing an old total in its place, as if it were
    // current, would be worse than showing nothing.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])
    await new Promise((r) => setTimeout(r, 15))
    await repo.insertMany(JOB_ID, REQ_2, [
      pairLeg({
        flight: 'AD100', cash: 200.00, outDate: OUT, retDate: RET,
        isReturn: false, inboundUnavailable: true,
      }),
    ])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    expect(current.best_cash).toBeNull()
    expect(current.inbound_unavailable).toBe(true)
  })

  it('getLatestPairs também ignora a coleta que só trouxe as idas', async () => {
    // This is the query feeding the evaluation cycle and the e-mail. Without the
    // filter no alert went out: the truncated collection won and there was no pair.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])
    await new Promise((r) => setTimeout(r, 15))
    await repo.insertMany(JOB_ID, REQ_2, [
      pairLeg({ flight: 'AD100', cash: 200.00, outDate: OUT, retDate: RET, isReturn: false }),
    ])

    const rows = await repo.getLatestPairs('azul', 'CNF', 'VCP', OUT, OUT, RET, RET)

    expect(rows.filter((r) => r.is_return)).toHaveLength(1)
    expect(rows.every((r) => r.request_id === REQ_1)).toBe(true)
  })

  it('volta com a rota da IDA não fecha par, mesmo sendo a mais barata', async () => {
    // Portrait of request 8be20a19: the LATAM returns screen did not advance and
    // the OUTBOUND cards were written with is_return. The ghost row is the cheapest
    // of the batch on purpose — if it leaked, it would win the total.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300.00, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
      fare('AD100', 100.00, {
        flight_date: RET, is_return: true, origin: 'CNF', destination: 'VCP',
        return_date: RET, paired_outbound_flight: 'AD100',
      }),
    ])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    // 365.45 + 300 = 665.45 through the legitimate return. With the ghost it would
    // be 465.45 — two CNF→VCP legs summed as if they were a round trip.
    expect(Number(current.best_cash)).toBe(665.45)
    expect(Number(current.best_cash_inbound)).toBe(300)
  })

  it('volta que pousa em outro aeroporto da cidade fecha par normalmente', async () => {
    // BA returns LCY→GRU inbounds on a GRU→LHR search. The ghost cut is by a route
    // EQUAL to the outbound; demanding the exact inverse would zero out the BA pair.
    await repo.insertMany(JOB_ID, REQ_1, [
      fare('BA246', 3276.00, {
        flight_date: OUT, is_return: false, origin: 'GRU', destination: 'LHR',
        airline: 'britishairways', return_date: RET,
      }),
      fare('BA247', 1000.00, {
        flight_date: RET, is_return: true, origin: 'LCY', destination: 'GRU',
        airline: 'britishairways', return_date: RET, paired_outbound_flight: 'BA246',
      }),
    ])

    const current = await repo.getCurrentBest(
      ['britishairways'], 'GRU', 'LHR', OUT, OUT, { from: RET, to: RET },
    )

    expect(Number(current.best_cash)).toBe(4276)
    expect(Number(current.best_cash_inbound)).toBe(1000)
  })

  it('bundle da companhia: total sem parcelas, porque não há divisão publicada', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 566.28, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])
    // `insertMany` does not write bundle_* yet (round-trip phase 2); the UPDATE
    // simulates the collection that will, so the display is already correct.
    await pool.query(
      `UPDATE ${SCHEMA}.flight_fares SET bundle_cash = 700 WHERE flight_number = 'AD100'`,
    )

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    // The bundle is a single price; splitting it into outbound and return would
    // show a number the airline never offered.
    expect(Number(current.best_cash)).toBe(700)
    expect(current.best_cash_outbound).toBeNull()
    expect(current.best_cash_inbound).toBeNull()
  })

  it('volta indefinida: sem total, com o motivo (exibe "-", não alerta)', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false, inboundUnavailable: true }),
    ])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    // The outbound price is NOT the trip price: no 365.45 here.
    expect(current.best_cash).toBeNull()
    expect(current.inbound_unavailable).toBe(true)
  })

  /**
   * REGRESSION — the card verdict compared different quantities.
   *
   * `best_cash` of an RT routine is the pair TOTAL (two legs), but the baseline
   * came from fares with origin→destination, which excludes the return (inverted
   * route). A total against the average of ONE leg makes every round trip look
   * expensive forever — including on the best offer the route ever had.
   */
  it('a régua do round-trip é de TOTAIS de par, não de pernas', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 400, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])

    const pair = await repo.getSummary(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })
    const oneWay = await repo.getSummary(['azul'], 'CNF', 'VCP', OUT, OUT)

    // 400 + 300: the baseline speaks in the same quantity as the card value.
    expect(Number(pair.avg_cash_30d)).toBe(700)
    expect(Number(pair.min_cash_30d)).toBe(700)

    // And a one-way routine does not see a pair leg: a different price context.
    expect(oneWay.avg_cash_30d).toBeNull()
  })

  it('calendário de round-trip traz o total do par por data de IDA', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 400, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD200', cash: 500, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
      pairLeg({ flight: 'AD901', cash: 150, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD200' }),
    ])

    const dates = await repo.getPriceByDate(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    // 500 + 150 = 650 beats 400 + 300 = 700. The forbidden crossing (400 + 150)
    // would give 550 — a pair the airline never offered.
    expect(dates).toHaveLength(1)
    expect(Number(dates[0].best_cash)).toBe(650)
  })

  it('sem a janela de volta o calendário ignora tarifas de par', async () => {
    // This was why the calendar came back EMPTY on an RT routine: pair collection
    // writes both legs with return_date, and the one-way branch filters IS NULL.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 400, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])

    expect(await repo.getPriceByDate(['azul'], 'CNF', 'VCP', OUT, OUT)).toHaveLength(0)
    expect(await repo.getPriceByDate(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })).toHaveLength(1)
  })

  it('tarifa avulsa não vaza para o total do par, nem o contrário', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [fare('AD4188', 100.00)])
    await repo.insertMany(JOB_ID, REQ_2, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 566.28, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])

    const pair = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })
    const oneWay = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT)

    expect(Number(pair.best_cash)).toBe(931.73)
    expect(Number(oneWay.best_cash)).toBe(100)
  })

  // ── frescor do preço atual ────────────────────────────────────────────────
  // Medido em 2026-08-24: o card mostrava a tarifa de uma data cuja coleta havia
  // parado, enquanto outras cinco datas eram atualizadas a cada hora. Rodar a
  // rotina de novo não corrigia — a linha velha seguia ganhando o MIN, porque a
  // única validade era de 30 dias.
  /**
   * O par já somava em Real desde a 017. A só-ida ficou para trás: elegia a moeda
   * mais frequente da janela e descartava o resto, então o card exibia GBP numa
   * rotina e R$ na de baixo, e o gráfico ficava numa escala e a base de 30 dias
   * noutra. O dashboard agora é todo em Real.
   */
  describe('a régua da só-ida é em Real', () => {
    const emLibra = (flight: string, gbp: number, brl: number) =>
      fare(flight, gbp, { currency: 'GBP', fare_cash_brl: brl, fx_rate: brl / gbp })

    it('coleta em libra sai como BRL, com o valor convertido na coleta', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [emLibra('BA247', 511, 3847.83)])

      const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-12', '2026-07-12')

      expect(current.currency).toBe('BRL')
      expect(Number(current.best_cash)).toBeCloseTo(3847.83, 2)
    })

    it('duas moedas na janela: ninguém é descartado e o menor é o menor em Real', async () => {
      // GBP 511 = R$3.847,83 não é mais barato que R$1.200 só por 511 < 1200 — era
      // exatamente esse o risco de comparar números de mercados diferentes.
      await repo.insertMany(JOB_ID, REQ_1, [
        emLibra('BA247', 511, 3847.83),
        fare('AD4188', 1200, { flight_date: '2026-07-13' }),
      ])

      const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-12', '2026-07-13')

      expect(current.currency).toBe('BRL')
      expect(Number(current.best_cash)).toBe(1200)
    })

    it('a base de 30 dias segue a mesma régua', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [
        emLibra('BA247', 511, 3847.83),
        fare('AD4188', 1200, { flight_date: '2026-07-13' }),
      ])

      const summary = await repo.getSummary(['azul'], 'CNF', 'VCP', '2026-07-12', '2026-07-13')

      expect(summary.currency).toBe('BRL')
      // A data em libra continua na média: antes ela sumia da régua inteira.
      expect(Number(summary.min_cash_30d)).toBe(1200)
      expect(Number(summary.avg_cash_30d)).toBeCloseTo((3847.83 + 1200) / 2, 2)
    })

    it('tarifa sem cotação confiável fica fora da régua, não entra crua', async () => {
      // fare_cash_brl NULL = linha anterior à 017, ou sem cotação no momento.
      // Deixar o valor original entrar somaria libra com Real na mesma coluna.
      await repo.insertMany(JOB_ID, REQ_1, [
        fare('BA247', 511, { currency: 'GBP', fare_cash_brl: null, fx_rate: null }),
        fare('AD4188', 1200, { flight_date: '2026-07-13' }),
      ])

      const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-12', '2026-07-13')

      expect(Number(current.best_cash)).toBe(1200)
    })
  })

  describe('frescor e idade do preço', () => {
    it('coleta fora da janela sai do melhor preço', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 500.00, { flight_date: '2026-07-12' })])
      await repo.insertMany(JOB_ID, REQ_2, [fare('AD2', 900.00, { flight_date: '2026-07-13' })])
      await envelhecer(REQ_1, 60) // a mais barata, mas velha

      const best = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(Number(best.best_cash)).toBe(900)
    })

    it('dentro da janela, a mais barata continua valendo', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 500.00, { flight_date: '2026-07-12' })])
      await repo.insertMany(JOB_ID, REQ_2, [fare('AD2', 900.00, { flight_date: '2026-07-13' })])
      await envelhecer(REQ_1, 12)

      const best = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(Number(best.best_cash)).toBe(500)
    })

    it('janela é parâmetro: 6h derruba o que 24h aceitava', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 500.00, { flight_date: '2026-07-12' })])
      await repo.insertMany(JOB_ID, REQ_2, [fare('AD2', 900.00, { flight_date: '2026-07-13' })])
      await envelhecer(REQ_1, 12)

      const best = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31', undefined, 6)

      expect(Number(best.best_cash)).toBe(900)
    })

    it('data com job morto sai na hora, sem esperar a janela', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 500.00, { flight_date: '2026-07-12' })])
      await repo.insertMany(JOB_ID, REQ_2, [fare('AD2', 900.00, { flight_date: '2026-07-13' })])
      await matarJob('2026-07-12')

      const best = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(Number(best.best_cash)).toBe(900)
    })

    // O card carimba "verificado há x" com este campo. Com MAX(scraped_at) ele
    // usava a hora de OUTRA data, a que tinha acabado de ser coletada.
    it('best_cash_at é a hora da tarifa vencedora, não a da coleta mais recente', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 500.00, { flight_date: '2026-07-12' })])
      await repo.insertMany(JOB_ID, REQ_2, [fare('AD2', 900.00, { flight_date: '2026-07-13' })])
      await envelhecer(REQ_1, 10)

      const best = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(Number(best.best_cash)).toBe(500)
      const idadeH = (Date.now() - new Date(best.best_cash_at!).getTime()) / 3_600_000
      expect(idadeH).toBeGreaterThan(9)
      expect(idadeH).toBeLessThan(11)
      // scraped_at continua sendo o retrato mais novo da grade
      const gradeH = (Date.now() - new Date(best.scraped_at!).getTime()) / 3_600_000
      expect(gradeH).toBeLessThan(1)
    })

    it('calendário usa a mesma janela do card', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 500.00, { flight_date: '2026-07-12' })])
      await repo.insertMany(JOB_ID, REQ_2, [fare('AD2', 900.00, { flight_date: '2026-07-13' })])
      await envelhecer(REQ_1, 60)

      const datas = await repo.getPriceByDate(['azul'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(datas.map((d) => toDateStr(d.flight_date))).toEqual(['2026-07-13'])
    })
  })

  /**
   * Rotina com mais de uma companhia.
   *
   * O `DISTINCT ON (flight_date)` das leituras não tinha a companhia na chave:
   * por data sobrava a coleta MAIS RECENTE de uma companhia só, e o join por
   * request_id descartava as outras. Com uma companhia é invisível; com duas, a
   * tela mostra o preço de quem raspou por último e troca a cada coleta.
   *
   * Todo caso aqui põe a tarifa CARA na coleta mais nova de propósito: é o
   * arranjo em que a chave errada e a chave certa dão respostas diferentes.
   */
  describe('multi-companhia', () => {
    const JOB_LA = '00000000-0000-0000-0000-0000000000bb'
    const REQ_3  = '33333333-3333-3333-3333-333333333333'

    /** Tarifa da LATAM na mesma rota — a companhia é o que muda. */
    const latam = (flight: string, cash: number, over: Partial<FareInput> = {}) =>
      fare(flight, cash, { airline: 'latam', ...over })

    it('card pega a MAIS BARATA entre companhias, não a coletada por último', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 900.00, { flight_date: '2026-07-12' })])
      await new Promise((r) => setTimeout(r, 15))
      await repo.insertMany(JOB_LA, REQ_3, [latam('LA1', 1500.00, { flight_date: '2026-07-12' })])

      const best = await repo.getCurrentBest(['azul', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(Number(best.best_cash)).toBe(900)
    })

    it('calendário pega a MAIS BARATA entre companhias, por data', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 900.00, { flight_date: '2026-07-12' })])
      await new Promise((r) => setTimeout(r, 15))
      await repo.insertMany(JOB_LA, REQ_3, [latam('LA1', 1500.00, { flight_date: '2026-07-12' })])

      const datas = await repo.getPriceByDate(['azul', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(datas).toHaveLength(1)
      expect(Number(datas[0].best_cash)).toBe(900)
    })

    // A régua de 30 dias diz se o preço de hoje é bom. Feita só de quem raspou
    // por último em cada dia, ela descreve o rodízio do despacho, não a rota.
    it('régua de 30 dias enxerga as duas companhias', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 400.00, { flight_date: '2026-07-12' })])
      await new Promise((r) => setTimeout(r, 15))
      await repo.insertMany(JOB_LA, REQ_3, [latam('LA1', 1600.00, { flight_date: '2026-07-12' })])

      const resumo = await repo.getSummary(['azul', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(Number(resumo.min_cash_30d)).toBe(400)
      expect(Number(resumo.avg_cash_30d)).toBe(1000)
    })

    // O calendário one-way somava em fare_cash, na moeda coletada, enquanto o
    // card e o calendário de par já somavam em Real. Com duas companhias em
    // mercados diferentes o MIN elegia a libra por ser o número menor.
    it('calendário compara em Real, não no número coletado', async () => {
      // A BA é a coleta MAIS NOVA de propósito: assim ela é a que sobrevivia à
      // chave sem companhia, e o teste separa as duas correções de uma vez —
      // com a chave errada devolvia £730 como se fosse o menor preço.
      await repo.insertMany(JOB_LA, REQ_3, [latam('LA1', 4900.00)])
      await new Promise((r) => setTimeout(r, 15))
      // BA em libra: £730, e os R$ 5.110 que 017 congela na coleta.
      await repo.insertMany(JOB_ID, REQ_1, [fare('BA1', 730.00, {
        airline: 'britishairways', currency: 'GBP',
        fare_cash_brl: 5110.00, fx_rate: 7,
      })])

      const datas = await repo.getPriceByDate(['britishairways', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(datas).toHaveLength(1)
      expect(Number(datas[0].best_cash)).toBe(4900)
    })

    // O card mostra um número só. Com várias companhias, esconder QUEM cobrou
    // esconde a informação que decide a compra: em qual site comprar.
    it('card diz qual companhia venceu e quais foram analisadas', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 900.00, { flight_date: '2026-07-12' })])
      await new Promise((r) => setTimeout(r, 15))
      await repo.insertMany(JOB_LA, REQ_3, [latam('LA1', 1500.00, { flight_date: '2026-07-12' })])

      const best = await repo.getCurrentBest(['azul', 'latam'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(Number(best.best_cash)).toBe(900)
      expect(best.best_cash_airline).toBe('azul')
      expect([...best.analysed_airlines].sort()).toEqual(['azul', 'latam'])
    })

    // Companhia que não respondeu não foi analisada. Dizer que foi é mentir
    // sobre a cobertura no lugar onde o usuário confere se olhamos por ele.
    it('analysed_airlines lista quem respondeu, não quem a rotina pediu', async () => {
      await repo.insertMany(JOB_ID, REQ_1, [fare('AD1', 900.00, { flight_date: '2026-07-12' })])

      const best = await repo.getCurrentBest(
        ['azul', 'latam', 'britishairways'], 'CNF', 'VCP', '2026-07-01', '2026-07-31')

      expect(best.analysed_airlines).toEqual(['azul'])
    })

    it('total do par pega a companhia mais barata, não a mais recente', async () => {
      const OUT = '2026-07-12'
      const RET = '2026-07-20'
      await repo.insertMany(JOB_ID, REQ_1, [
        pairLeg({ flight: 'AD1', cash: 400, outDate: OUT, retDate: RET, isReturn: false }),
        pairLeg({ flight: 'AD9', cash: 300, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD1' }),
      ])
      await new Promise((r) => setTimeout(r, 15))
      await repo.insertMany(JOB_LA, REQ_3, [
        { ...pairLeg({ flight: 'LA1', cash: 900, outDate: OUT, retDate: RET, isReturn: false }), airline: 'latam' },
        { ...pairLeg({ flight: 'LA9', cash: 800, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'LA1' }), airline: 'latam' },
      ])

      const best = await repo.getCurrentBest(
        ['azul', 'latam'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

      expect(Number(best.best_cash)).toBe(700)
      expect(best.best_cash_airline).toBe('azul')
      expect([...best.analysed_airlines].sort()).toEqual(['azul', 'latam'])
    })
  })
})
