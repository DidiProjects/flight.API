import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { AirlinesRepository } from './AirlinesRepository'

// Recomendação de companhia por trajeto. Roda contra Postgres real porque a
// regra inteira vive no SQL (mapa de mercado cruzado com a lista de aeroportos).
// Pulado sem TEST_DATABASE_URL — a CI sobe um Postgres e define a variável.
//
// Local:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'airlines_reco_it'

const describeIt = DB_URL ? describe : describe.skip

describeIt('AirlinesRepository.findRecommendedForRoute (integração / Postgres real)', () => {
  let pool: Pool
  let repo: AirlinesRepository

  /** Só o que a recomendação lê, sem FK, para o schema ficar autocontido. */
  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA},public` })
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.airlines (
        code VARCHAR(20) PRIMARY KEY, name VARCHAR(100) NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        has_cash BOOLEAN NOT NULL DEFAULT true, has_pts BOOLEAN NOT NULL DEFAULT false,
        has_hyb BOOLEAN NOT NULL DEFAULT false, has_roundtrip BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.airports (
        airline_code VARCHAR(20) NOT NULL, airport_code VARCHAR(10) NOT NULL,
        country_code VARCHAR(10),
        PRIMARY KEY (airline_code, airport_code)
      );
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.markets (
        code VARCHAR(10) PRIMARY KEY, name VARCHAR(100) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.market_countries (
        market_code VARCHAR(10) NOT NULL, country_code VARCHAR(2) NOT NULL,
        PRIMARY KEY (market_code, country_code)
      );
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.airline_markets (
        airline_code VARCHAR(20) NOT NULL, market_code VARCHAR(10) NOT NULL,
        PRIMARY KEY (airline_code, market_code)
      );
    `)

    await pool.query(`
      INSERT INTO ${SCHEMA}.airlines (code, name, active) VALUES
        ('azul','Azul',true), ('latam','LATAM',true),
        ('britishairways','British Airways',true), ('ryanair','Ryanair',true),
        ('gol','GOL',false);

      INSERT INTO ${SCHEMA}.markets (code, name) VALUES
        ('br','Brasil'), ('gb','Reino Unido'), ('pe','Peru'), ('eee','EEE');

      INSERT INTO ${SCHEMA}.market_countries VALUES
        ('br','br'), ('gb','gb'), ('pe','pe'),
        ('eee','es'), ('eee','it'), ('eee','ie'), ('eee','se'), ('eee','pt');

      INSERT INTO ${SCHEMA}.airline_markets VALUES
        ('azul','br'), ('gol','br'),
        ('latam','br'), ('latam','pe'),
        ('britishairways','gb'),
        ('ryanair','eee'), ('ryanair','gb');
    `)

    // Listas de aeroportos como a `airports` real: a da LATAM e a da BA são
    // destinos bilhetáveis (com codeshare dentro), a da Azul é rede operada.
    // A GOL entra com country_code em MAIÚSCULA, que é como ela está no banco.
    await pool.query(`
      INSERT INTO ${SCHEMA}.airports (airline_code, airport_code, country_code) VALUES
        ('azul','GRU','br'), ('azul','CNF','br'), ('azul','CGH','br'), ('azul','SDU','br'),
        ('latam','GRU','br'), ('latam','CNF','br'), ('latam','CGH','br'), ('latam','SDU','br'),
        ('latam','LIM','pe'), ('latam','LHR','gb'), ('latam','MAD','es'), ('latam','BCN','es'),
        ('latam','STN','gb'), ('latam','ARN','se'),
        ('britishairways','GRU','br'), ('britishairways','CNF','br'),
        ('britishairways','CGH','br'), ('britishairways','SDU','br'),
        ('britishairways','LHR','gb'), ('britishairways','EDI','gb'),
        ('britishairways','MAD','es'), ('britishairways','BCN','es'),
        ('britishairways','STN','gb'), ('britishairways','ARN','se'),
        ('britishairways','LIM','pe'),
        ('ryanair','MAD','es'), ('ryanair','BCN','es'),
        ('ryanair','STN','gb'), ('ryanair','ARN','se'), ('ryanair','EDI','gb'),
        ('gol','GRU','BR'), ('gol','CNF','BR');
    `)

    repo = new AirlinesRepository(pool)
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await pool.end()
    }
  })

  const recomendadas = async (o: string, d: string) =>
    (await repo.findRecommendedForRoute(o, d)).filter((a) => a.recommended).map((a) => a.code).sort()

  const motivo = async (o: string, d: string, code: string) =>
    (await repo.findRecommendedForRoute(o, d)).find((a) => a.code === code)?.reason

  // O caso que motivou o mapa inteiro: as duas listas contêm MAD e BCN, mas
  // cabotagem impede uma companhia brasileira de vender um voo doméstico
  // espanhol. A Ryanair pode porque o EEE é mercado único.
  it('doméstico espanhol sobra só a Ryanair', async () => {
    expect(await recomendadas('MAD', 'BCN')).toEqual(['ryanair'])
    expect(await motivo('MAD', 'BCN', 'latam')).toBe('outside_market')
  })

  it('doméstico brasileiro exclui a British Airways', async () => {
    expect(await recomendadas('CGH', 'SDU')).toEqual(['azul', 'latam'])
    expect(await motivo('CGH', 'SDU', 'britishairways')).toBe('outside_market')
  })

  it('doméstico britânico sobra só a BA — a Ryanair não atende Heathrow', async () => {
    expect(await recomendadas('LHR', 'EDI')).toEqual(['britishairways'])
    expect(await motivo('LHR', 'EDI', 'ryanair')).toBe('no_route')
  })

  // Ryanair pertence a DOIS mercados: EEE pelo AOC irlandês e Reino Unido pelo
  // AOC britânico separado que mantém desde o Brexit.
  it('Stansted–Arlanda aceita BA e Ryanair, e corta a LATAM', async () => {
    expect(await recomendadas('STN', 'ARN')).toEqual(['britishairways', 'ryanair'])
    expect(await motivo('STN', 'ARN', 'latam')).toBe('outside_market')
  })

  it('internacional com uma ponta em casa mantém as duas companhias', async () => {
    expect(await recomendadas('GRU', 'LHR')).toEqual(['britishairways', 'latam'])
  })

  it('Brasil–Peru corta a BA, que só tem direito de tráfego no Reino Unido', async () => {
    expect(await recomendadas('GRU', 'LIM')).toEqual(['latam'])
    expect(await motivo('GRU', 'LIM', 'britishairways')).toBe('outside_market')
  })

  // O mapa decide o padrão, nunca o teto: quem discorda ainda escolhe à mão.
  it('devolve TODAS as ativas, recomendadas ou não, e as recomendadas primeiro', async () => {
    const lista = await repo.findRecommendedForRoute('MAD', 'BCN')
    expect(lista.map((a) => a.code).sort()).toEqual(['azul', 'britishairways', 'latam', 'ryanair'])
    expect(lista[0].code).toBe('ryanair')
    expect(lista.every((a) => a.code !== 'gol')).toBe(true)
  })

  // A GOL está com country_code em MAIÚSCULA na `airports`; sem lower() dos dois
  // lados ela sumiria de todo filtro por país. Está inativa, então não pode ser
  // recomendada — mas a comparação em si precisa funcionar quando ela voltar.
  it('caixa do country_code não decide nada: comparação é em minúscula', async () => {
    await pool.query(`UPDATE ${SCHEMA}.airlines SET active = true WHERE code = 'gol'`)
    try {
      expect(await recomendadas('GRU', 'CNF')).toContain('gol')
    } finally {
      await pool.query(`UPDATE ${SCHEMA}.airlines SET active = false WHERE code = 'gol'`)
    }
  })

  it('minúsculas no parâmetro não mudam a resposta', async () => {
    expect(await recomendadas('mad', 'bcn')).toEqual(['ryanair'])
  })
})
