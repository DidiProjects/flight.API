import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { FareHistoryRepository } from './FareHistoryRepository'

// The whole behaviour of this repository lives in one SQL statement — pair
// derivation, itinerary upsert, and the choice between widening the open price
// segment and opening a new one. A mock would only prove the string is passed
// along, so it runs against a real Postgres.
// Skipped when TEST_DATABASE_URL is unset — CI starts the Postgres.
//
// Locally:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'fare_history_it'

const describeIt = DB_URL ? describe : describe.skip

/** A fare row, with only the columns the derivation reads. */
interface FareSeed {
  requestId: string
  scrapedAt: string
  airline?: string
  origin: string
  destination: string
  flightNumber: string
  flightDate: string
  isReturn?: boolean
  returnDate?: string | null
  pairedOutboundFlight?: string | null
  currency?: string
  fareCash?: number | null
  fareCashBrl?: number | null
  fxRate?: number | null
}

describeIt('FareHistoryRepository (integração / Postgres real)', () => {
  let pool: Pool
  let repo: FareHistoryRepository

  async function seed(rows: FareSeed[]): Promise<void> {
    for (const r of rows) {
      await pool.query(
        `INSERT INTO flight_fares
           (request_id, airline, origin, destination, flight_number, flight_date,
            is_return, return_date, paired_outbound_flight, currency,
            fare_cash, fare_cash_brl, fx_rate, scraped_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          r.requestId, r.airline ?? 'azul', r.origin, r.destination, r.flightNumber, r.flightDate,
          r.isReturn ?? false, r.returnDate ?? null, r.pairedOutboundFlight ?? null, r.currency ?? 'BRL',
          r.fareCash ?? null, r.fareCashBrl ?? r.fareCash ?? null, r.fxRate ?? 1, r.scrapedAt,
        ],
      )
    }
  }

  /** One round-trip run: outbound AD100 + return AD200 priced under it. */
  async function seedPair(requestId: string, scrapedAt: string, cash: { out: number; back: number }): Promise<void> {
    await seed([
      { requestId, scrapedAt, origin: 'GRU', destination: 'CNF', flightNumber: 'AD100',
        flightDate: '2027-01-09', returnDate: '2027-01-15', fareCash: cash.out },
      { requestId, scrapedAt, origin: 'CNF', destination: 'GRU', flightNumber: 'AD200',
        flightDate: '2027-01-15', isReturn: true, returnDate: '2027-01-15',
        pairedOutboundFlight: 'AD100', fareCash: cash.back },
    ])
  }

  async function segments(): Promise<{ amount_cash: string; observation_count: number; observed_from: Date; last_seen_at: Date }[]> {
    const { rows } = await pool.query(
      `SELECT h.amount_cash, h.observation_count, h.observed_from, h.last_seen_at
         FROM fare_price_history h ORDER BY h.observed_from`,
    )
    return rows
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)

    // Mirrors the real schema, self-contained (no FK to airlines).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.flight_fares (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id        UUID,
        airline           VARCHAR(20)  NOT NULL,
        origin            VARCHAR(10)  NOT NULL,
        destination       VARCHAR(10)  NOT NULL,
        flight_number     VARCHAR(20),
        flight_date       DATE         NOT NULL,
        is_return         BOOLEAN      NOT NULL DEFAULT FALSE,
        return_date       DATE,
        paired_outbound_flight VARCHAR(20),
        currency          VARCHAR(3)   NOT NULL,
        fare_cash         NUMERIC(10,2),
        fare_pts          NUMERIC(10,0),
        fare_hyb_pts      NUMERIC(10,0),
        fare_hyb_cash     NUMERIC(10,2),
        fare_cash_brl     NUMERIC(12,2),
        fare_hyb_cash_brl NUMERIC(12,2),
        fx_rate           NUMERIC(18,8),
        fx_rate_date      DATE,
        bundle_cash       NUMERIC(10,2),
        bundle_pts        NUMERIC(10,0),
        bundle_hyb_pts    NUMERIC(10,0),
        bundle_hyb_cash   NUMERIC(10,2),
        scraped_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.fare_itineraries (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        airline                VARCHAR(20) NOT NULL,
        trip_type              VARCHAR(10) NOT NULL CHECK (trip_type IN ('one_way', 'round_trip')),
        origin                 VARCHAR(10) NOT NULL,
        destination            VARCHAR(10) NOT NULL,
        outbound_flight_number VARCHAR(20) NOT NULL,
        outbound_date          DATE        NOT NULL,
        inbound_flight_number  VARCHAR(20),
        inbound_date           DATE,
        currency               VARCHAR(3)  NOT NULL,
        first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT fare_itineraries_trip_shape CHECK (
          (trip_type = 'one_way'    AND inbound_flight_number IS NULL     AND inbound_date IS NULL) OR
          (trip_type = 'round_trip' AND inbound_flight_number IS NOT NULL AND inbound_date IS NOT NULL)
        )
      )
    `)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fare_itineraries_identity
        ON ${SCHEMA}.fare_itineraries(airline, trip_type, origin, destination,
                                      outbound_flight_number, outbound_date,
                                      inbound_flight_number, inbound_date)
        NULLS NOT DISTINCT
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.fare_price_history (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        itinerary_id        UUID NOT NULL REFERENCES ${SCHEMA}.fare_itineraries(id) ON DELETE CASCADE,
        currency            VARCHAR(3) NOT NULL,
        amount_cash         NUMERIC(10,2),
        amount_pts          NUMERIC(10,0),
        amount_hyb_pts      NUMERIC(10,0),
        amount_hyb_cash     NUMERIC(10,2),
        amount_cash_brl     NUMERIC(12,2),
        amount_hyb_cash_brl NUMERIC(12,2),
        fx_rate             NUMERIC(18,8),
        fx_rate_date        DATE,
        observed_from       TIMESTAMPTZ NOT NULL,
        last_seen_at        TIMESTAMPTZ NOT NULL,
        observation_count   INT NOT NULL DEFAULT 1,
        CONSTRAINT fare_price_history_window CHECK (last_seen_at >= observed_from)
      )
    `)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fare_price_history_segment
        ON ${SCHEMA}.fare_price_history(itinerary_id, observed_from)
    `)

    repo = new FareHistoryRepository(pool)
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.fare_itineraries, ${SCHEMA}.flight_fares CASCADE`)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  it('a primeira coleta de um par cria o itinerário e abre o segmento com o total', async () => {
    await seedPair('11111111-1111-1111-1111-111111111111', '2026-08-01T10:00:00Z', { out: 400, back: 300 })

    const opened = await repo.recordRun('11111111-1111-1111-1111-111111111111')

    expect(opened).toBe(1)
    const { rows } = await pool.query(`SELECT * FROM fare_itineraries`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      trip_type: 'round_trip',
      outbound_flight_number: 'AD100',
      inbound_flight_number: 'AD200',
    })
    // The tracked price is the TRIP total, the same quantity the card shows.
    expect(await segments()).toMatchObject([{ amount_cash: '700.00', observation_count: 1 }])
  })

  it('preço igual na coleta seguinte alarga o segmento em vez de abrir outro', async () => {
    await seedPair('11111111-1111-1111-1111-111111111111', '2026-08-01T10:00:00Z', { out: 400, back: 300 })
    await repo.recordRun('11111111-1111-1111-1111-111111111111')

    await seedPair('22222222-2222-2222-2222-222222222222', '2026-08-01T11:00:00Z', { out: 400, back: 300 })
    const opened = await repo.recordRun('22222222-2222-2222-2222-222222222222')

    expect(opened).toBe(0)
    const segs = await segments()
    expect(segs).toHaveLength(1)
    expect(segs[0].observation_count).toBe(2)
    // The window widened: same start, later end.
    expect(segs[0].observed_from.toISOString()).toBe('2026-08-01T10:00:00.000Z')
    expect(segs[0].last_seen_at.toISOString()).toBe('2026-08-01T11:00:00.000Z')
  })

  it('preço diferente abre um segmento novo e não mexe no anterior', async () => {
    await seedPair('11111111-1111-1111-1111-111111111111', '2026-08-01T10:00:00Z', { out: 400, back: 300 })
    await repo.recordRun('11111111-1111-1111-1111-111111111111')

    await seedPair('33333333-3333-3333-3333-333333333333', '2026-08-02T10:00:00Z', { out: 450, back: 300 })
    const opened = await repo.recordRun('33333333-3333-3333-3333-333333333333')

    expect(opened).toBe(1)
    const segs = await segments()
    expect(segs.map((s) => s.amount_cash)).toEqual(['700.00', '750.00'])
    expect(segs[0].observation_count).toBe(1)
    // The itinerary is still one: the identity does not move with the price.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM fare_itineraries`)
    expect(rows[0].n).toBe(1)
  })

  it('reprocessar o mesmo callback não inventa observação nem segmento', async () => {
    await seedPair('11111111-1111-1111-1111-111111111111', '2026-08-01T10:00:00Z', { out: 400, back: 300 })
    await repo.recordRun('11111111-1111-1111-1111-111111111111')

    const opened = await repo.recordRun('11111111-1111-1111-1111-111111111111')

    expect(opened).toBe(0)
    expect(await segments()).toMatchObject([{ observation_count: 1 }])
  })

  it('ida simples vira itinerário sem volta, e a coleta seguinte não duplica', async () => {
    const single = (requestId: string, scrapedAt: string) => seed([
      { requestId, scrapedAt, airline: 'ryanair', origin: 'STN', destination: 'DUB',
        flightNumber: 'FR100', flightDate: '2026-12-01', currency: 'GBP', fareCash: 55 },
    ])

    await single('44444444-4444-4444-4444-444444444444', '2026-08-01T10:00:00Z')
    await repo.recordRun('44444444-4444-4444-4444-444444444444')
    await single('55555555-5555-5555-5555-555555555555', '2026-08-01T12:00:00Z')
    await repo.recordRun('55555555-5555-5555-5555-555555555555')

    const { rows } = await pool.query(`SELECT trip_type, inbound_flight_number, currency FROM fare_itineraries`)
    // NULLS NOT DISTINCT is what makes the second run collide with the first
    // instead of inserting a twin whose inbound columns are both NULL.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trip_type: 'one_way', inbound_flight_number: null, currency: 'GBP' })
    expect(await segments()).toMatchObject([{ observation_count: 2 }])
  })

  it('a mesma volta sob idas diferentes são itinerários distintos', async () => {
    await seed([
      { requestId: '66666666-6666-6666-6666-666666666666', scrapedAt: '2026-08-01T10:00:00Z',
        origin: 'GRU', destination: 'CNF', flightNumber: 'AD100', flightDate: '2027-01-09',
        returnDate: '2027-01-15', fareCash: 400 },
      { requestId: '66666666-6666-6666-6666-666666666666', scrapedAt: '2026-08-01T10:00:00Z',
        origin: 'GRU', destination: 'CNF', flightNumber: 'AD101', flightDate: '2027-01-09',
        returnDate: '2027-01-15', fareCash: 500 },
      { requestId: '66666666-6666-6666-6666-666666666666', scrapedAt: '2026-08-01T10:00:00Z',
        origin: 'CNF', destination: 'GRU', flightNumber: 'AD200', flightDate: '2027-01-15',
        isReturn: true, returnDate: '2027-01-15', pairedOutboundFlight: 'AD100', fareCash: 300 },
      { requestId: '66666666-6666-6666-6666-666666666666', scrapedAt: '2026-08-01T10:00:00Z',
        origin: 'CNF', destination: 'GRU', flightNumber: 'AD200', flightDate: '2027-01-15',
        isReturn: true, returnDate: '2027-01-15', pairedOutboundFlight: 'AD101', fareCash: 320 },
    ])

    const opened = await repo.recordRun('66666666-6666-6666-6666-666666666666')

    // AD200 costs a different price under each outbound — one series each.
    expect(opened).toBe(2)
    const segs = await segments()
    expect(segs.map((s) => s.amount_cash).sort()).toEqual(['700.00', '820.00'])
  })

  it('"volta" com a rota da ida é descartada: não vira par', async () => {
    await seed([
      { requestId: '77777777-7777-7777-7777-777777777777', scrapedAt: '2026-08-01T10:00:00Z',
        origin: 'GRU', destination: 'CNF', flightNumber: 'AD100', flightDate: '2027-01-09',
        returnDate: '2027-01-15', fareCash: 400 },
      // Outbound list read as returns: pairing it would add two legs in the same direction.
      { requestId: '77777777-7777-7777-7777-777777777777', scrapedAt: '2026-08-01T10:00:00Z',
        origin: 'GRU', destination: 'CNF', flightNumber: 'AD300', flightDate: '2027-01-15',
        isReturn: true, returnDate: '2027-01-15', pairedOutboundFlight: 'AD100', fareCash: 380 },
    ])

    const opened = await repo.recordRun('77777777-7777-7777-7777-777777777777')

    expect(opened).toBe(0)
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM fare_itineraries`)
    expect(rows[0].n).toBe(0)
  })

  describe('getSeries', () => {
    const ROUTE = {
      airlines: ['azul'], origin: 'GRU', destination: 'CNF',
      dateFrom: '2027-01-01', dateTo: '2027-01-31',
      inbound: { from: '2027-01-01', to: '2027-01-31' },
    }

    /** Writes a segment directly: getSeries reads history, it does not build it. */
    /**
     * `brl` apart from `cash` on purpose: the series reads the Real frozen at
     * collection, and passing a different collected currency is what proves it —
     * a GBP segment has to land on the chart already converted.
     */
    async function seedSegment(
      cash: number,
      fromHoursAgo: number,
      toHoursAgo: number,
      money: { currency?: string; brl?: number } = {},
    ): Promise<void> {
      const { rows } = await pool.query(
        `INSERT INTO fare_itineraries
           (airline, trip_type, origin, destination, outbound_flight_number, outbound_date,
            inbound_flight_number, inbound_date, currency)
         VALUES ('azul','round_trip','GRU','CNF',$1,'2027-01-09','AD200','2027-01-15',$2)
         ON CONFLICT (airline, trip_type, origin, destination, outbound_flight_number,
                      outbound_date, inbound_flight_number, inbound_date)
         DO UPDATE SET currency = EXCLUDED.currency
         RETURNING id`,
        [`AD${100 + cash}`, money.currency ?? 'BRL'],
      )
      await pool.query(
        `INSERT INTO fare_price_history
           (itinerary_id, currency, amount_cash, amount_cash_brl, observed_from, last_seen_at)
         VALUES ($1,$2,$3,$4, NOW() - ($5 || ' hours')::interval, NOW() - ($6 || ' hours')::interval)`,
        [rows[0].id, money.currency ?? 'BRL', cash, money.brl ?? cash, fromHoursAgo, toHoursAgo],
      )
    }

    it('um platô cobre todos os buckets que atravessou, não só o de origem', async () => {
      await seedSegment(700, 5, 1)

      const series = await repo.getSeries(ROUTE, 'day')

      const filled = series.buckets.filter((b) => b.samples > 0)
      expect(series.currency).toBe('BRL')
      // A five-hour segment lands on the hourly buckets it overlapped, not on one.
      expect(filled.length).toBeGreaterThanOrEqual(4)
      expect(filled.every((b) => b.min_cash === '700.00')).toBe(true)
    })

    it('buraco de coleta fica vazio em vez de virar linha reta', async () => {
      await seedSegment(700, 20, 18)

      const series = await repo.getSeries(ROUTE, 'day')

      const empty = series.buckets.filter((b) => b.samples === 0)
      expect(empty.length).toBeGreaterThan(0)
      expect(empty.every((b) => b.min_cash === null)).toBe(true)
    })

    it('o bucket leva o MENOR preço entre os itinerários que o cobrem', async () => {
      await seedSegment(700, 5, 1)
      await seedSegment(650, 5, 1)

      const series = await repo.getSeries(ROUTE, 'day')

      const filled = series.buckets.filter((b) => b.samples > 0)
      expect(filled.every((b) => b.min_cash === '650.00')).toBe(true)
      // Both segments counted, so the front can tell a thin sample from a solid one.
      expect(filled.some((b) => b.samples === 2)).toBe(true)
    })

    it('série em Real mesmo quando a companhia cobrou em outra moeda', async () => {
      // A libra na coleta, o Real no gráfico: é a mesma régua do total do card e
      // da base de 30 dias. Antes a série vinha na moeda coletada e as estatísticas
      // ao lado vinham em Real — mesmo rótulo, escalas diferentes na mesma caixa.
      await seedSegment(700, 5, 1, { currency: 'GBP', brl: 5271 })

      const series = await repo.getSeries(ROUTE, 'day')

      expect(series.currency).toBe('BRL')
      const filled = series.buckets.filter((b) => b.samples > 0)
      expect(filled.length).toBeGreaterThan(0)
      expect(filled.every((b) => b.min_cash === '5271.00')).toBe(true)
    })

    it('mercados diferentes convivem na mesma régua, nenhum é descartado', async () => {
      // A moeda mais frequente vencia e o resto da janela sumia sem deixar rastro.
      // Em Real os dois cabem, e o menor é o menor DE VERDADE: GBP 700 = R$5.271
      // não é mais barato que R$4.000 só por 700 < 4000.
      await seedSegment(700, 5, 1, { currency: 'GBP', brl: 5271 })
      await seedSegment(4000, 5, 1)

      const series = await repo.getSeries(ROUTE, 'day')

      const filled = series.buckets.filter((b) => b.samples > 0)
      expect(filled.every((b) => b.min_cash === '4000.00')).toBe(true)
      expect(filled.some((b) => b.samples === 2)).toBe(true)
    })

    it('rotina de par não enxerga itinerário de ida simples da mesma rota', async () => {
      await seedSegment(700, 5, 1)
      const { rows } = await pool.query(
        `INSERT INTO fare_itineraries
           (airline, trip_type, origin, destination, outbound_flight_number, outbound_date, currency)
         VALUES ('azul','one_way','GRU','CNF','AD999','2027-01-09','BRL') RETURNING id`,
      )
      await pool.query(
        `INSERT INTO fare_price_history
           (itinerary_id, currency, amount_cash, amount_cash_brl, observed_from, last_seen_at)
         VALUES ($1,'BRL',100,100, NOW() - INTERVAL '5 hours', NOW() - INTERVAL '1 hour')`,
        [rows[0].id],
      )

      const series = await repo.getSeries(ROUTE, 'day')

      // R$100 is the price of ONE leg. Letting it in would make the trip look
      // 7x cheaper than the card says.
      const filled = series.buckets.filter((b) => b.samples > 0)
      expect(filled.every((b) => b.min_cash === '700.00')).toBe(true)
    })
  })

  it('a limpeza apaga o itinerário parado e leva o histórico junto', async () => {
    await seedPair('11111111-1111-1111-1111-111111111111', '2026-08-01T10:00:00Z', { out: 400, back: 300 })
    await repo.recordRun('11111111-1111-1111-1111-111111111111')
    await pool.query(`UPDATE fare_itineraries SET last_seen_at = NOW() - INTERVAL '31 days'`)

    await seed([
      { requestId: '88888888-8888-8888-8888-888888888888', scrapedAt: new Date().toISOString(),
        airline: 'ryanair', origin: 'STN', destination: 'DUB', flightNumber: 'FR100',
        flightDate: '2026-12-01', currency: 'GBP', fareCash: 55 },
    ])
    await repo.recordRun('88888888-8888-8888-8888-888888888888')

    const removed = await repo.cleanupNotSeenSince(30)

    expect(removed).toBe(1)
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM fare_price_history`)
    // CASCADE: the stale itinerary's segment went with it, the fresh one stayed.
    expect(rows[0].n).toBe(1)
  })
})
