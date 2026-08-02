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

/** Coluna DATE volta do pg como Date; normaliza para YYYY-MM-DD. */
function toDateStr(v: string | Date): string {
  return v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10)
}

// Mesmo job (rota), execuções diferentes — exatamente o cenário de produção:
// scraping_jobs é por rota (permanente), cada coleta tem seu próprio request_id.
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
    return_date:            null,
    paired_outbound_flight: null,
    inbound_unavailable:    false,
    ...over,
  }
}

/**
 * Perna de um par ida-e-volta.
 *
 * A volta tem `flight_date` igual à data DELA (a data de volta) e não à da ida —
 * é o formato que o scraper realmente grava, e o que o SQL do par tem de casar
 * pelo request_id.
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

  // ── par ida-e-volta (1-para-N) ──────────────────────────────────────────────

  const OUT = '2026-07-12'
  const RET = '2026-07-20'

  it('REGRESSÃO: as duas pernas do par caem no MESMO grupo', async () => {
    // O bug: o par era casado por flight_date, mas a volta carrega a data DELA.
    // As pernas iam para grupos diferentes e TODO par real era descartado como
    // incompleto — a avaliação RT nunca produzia um total.
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 566.28, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])

    const rows = await repo.getLatestPairs('azul', 'CNF', 'VCP', OUT, OUT, RET, RET)

    expect(rows).toHaveLength(2)
    // As duas pernas compartilham a identidade do par e a data de ida.
    expect(new Set(rows.map((r) => r.request_id)).size).toBe(1)
    expect(rows.map((r) => toDateStr(r.pair_outbound_date))).toEqual([OUT, OUT])
    // A volta continua carregando a data DELA — é justamente por isso que
    // flight_date não serve para agrupar o par.
    const inbound = rows.find((r) => r.is_return)!
    expect(toDateStr(inbound.flight_date)).toBe(RET)
  })

  it('a mesma volta sob idas diferentes sobrevive ao dedup', async () => {
    // É o mecanismo do desconto RT: a volta AD900 custa diferente dependendo da
    // ida escolhida. Sem paired_outbound_flight na chave única, o ON CONFLICT
    // guardaria só a primeira e o 1-para-N ficaria sem dado.
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

    // 500 + 300 = 800 vence 365.45 + 566.28 = 931.73. O cruzamento proibido
    // (365.45 + 300) daria 665.45 — um par que a companhia nunca ofereceu.
    expect(Number(current.best_cash)).toBe(800)
    expect(current.inbound_unavailable).toBe(false)

    // As parcelas exibidas têm de ser as do par VENCEDOR. Pegar o menor out e o
    // menor in isoladamente devolveria 365.45 / 300 — o tal par inexistente.
    expect(Number(current.best_cash_outbound)).toBe(500)
    expect(Number(current.best_cash_inbound)).toBe(300)
    expect(
      Number(current.best_cash_outbound) + Number(current.best_cash_inbound),
    ).toBe(Number(current.best_cash))
  })

  it('bundle da companhia: total sem parcelas, porque não há divisão publicada', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 566.28, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])
    // `insertMany` ainda não grava bundle_* (Fase 2 do round-trip); o UPDATE
    // simula a coleta que vai preencher, para a exibição já estar correta.
    await pool.query(
      `UPDATE ${SCHEMA}.flight_fares SET bundle_cash = 700 WHERE flight_number = 'AD100'`,
    )

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    // O bundle é um preço único; dividi-lo em ida e volta mostraria um número
    // que a companhia não ofereceu.
    expect(Number(current.best_cash)).toBe(700)
    expect(current.best_cash_outbound).toBeNull()
    expect(current.best_cash_inbound).toBeNull()
  })

  it('volta indefinida: sem total, com o motivo (exibe "-", não alerta)', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 365.45, outDate: OUT, retDate: RET, isReturn: false, inboundUnavailable: true }),
    ])

    const current = await repo.getCurrentBest(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })

    // O preço da ida NÃO é o preço da viagem: nada de 365.45 aqui.
    expect(current.best_cash).toBeNull()
    expect(current.inbound_unavailable).toBe(true)
  })

  /**
   * REGRESSÃO — o veredito do card comparava grandezas diferentes.
   *
   * `best_cash` de uma rotina RT é o TOTAL do par (duas pernas), mas a régua
   * saía de tarifas com origin→destination, que exclui a volta (rota invertida).
   * Total contra média de UMA perna faz todo round-trip parecer caro para
   * sempre — inclusive na melhor oferta que a rota já teve.
   */
  it('a régua do round-trip é de TOTAIS de par, não de pernas', async () => {
    await repo.insertMany(JOB_ID, REQ_1, [
      pairLeg({ flight: 'AD100', cash: 400, outDate: OUT, retDate: RET, isReturn: false }),
      pairLeg({ flight: 'AD900', cash: 300, outDate: OUT, retDate: RET, isReturn: true, pairedTo: 'AD100' }),
    ])

    const pair = await repo.getSummary(['azul'], 'CNF', 'VCP', OUT, OUT, { from: RET, to: RET })
    const oneWay = await repo.getSummary(['azul'], 'CNF', 'VCP', OUT, OUT)

    // 400 + 300: a régua fala na mesma grandeza do valor exibido no card.
    expect(Number(pair.avg_cash_30d)).toBe(700)
    expect(Number(pair.min_cash_30d)).toBe(700)

    // E a rotina one-way não enxerga a perna de par: contexto de preço diferente.
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

    // 500 + 150 = 650 vence 400 + 300 = 700. O cruzamento proibido (400 + 150)
    // daria 550 — par que a companhia nunca ofereceu.
    expect(dates).toHaveLength(1)
    expect(Number(dates[0].best_cash)).toBe(650)
  })

  it('sem a janela de volta o calendário ignora tarifas de par', async () => {
    // Era o motivo de o calendário vir VAZIO em rotina RT: a coleta de par grava
    // as duas pernas com return_date, e o ramo one-way filtra return_date IS NULL.
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
})
