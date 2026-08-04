import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import fs from 'node:fs'
import path from 'node:path'

// Testa a limpeza de alvo incompatível com a companhia (migration 012 do
// flight.DB). Roda contra um Postgres real porque a regra vive no SQL — o
// `NOT EXISTS` que decide "nenhuma companhia da rotina precifica esta dimensão".
// Pulado quando TEST_DATABASE_URL não está definido — o CI sobe o Postgres.
//
// Local:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test
//
// A regra é a MESMA de `airline-capabilities.ts`, escrita duas vezes em
// linguagens diferentes: lá barra o que entra, aqui limpa o que já entrou. É por
// isso que ela é testada dos dois lados — as duas podem divergir.

const DB_URL = process.env.TEST_DATABASE_URL
const SCHEMA = 'routine_cleanup_it'

// A migration mora no flight.DB, projeto irmão. Ler o arquivo (em vez de copiar
// o SQL) é o que impede o teste de validar uma versão da regra que já mudou.
const MIGRATION = path.resolve(
  __dirname, '../../../../flight.DB/migrations/014_limpa_alvos_incompativeis_com_a_companhia.sql',
)

// Pular por caminho errado é pior que falhar: a suíte fica verde e a regra deixa
// de ser testada em silêncio — foi o que aconteceu quando a migration mudou de
// número. Sem banco, pula; COM banco e sem o arquivo, quebra.
if (DB_URL && !fs.existsSync(MIGRATION)) {
  throw new Error(`Migration não encontrada em ${MIGRATION} — o teste da limpeza pararia de rodar sem avisar`)
}

const describeIt = DB_URL ? describe : describe.skip

type Alvos = {
  priority?: string
  target_cash?: number | null
  target_pts?: number | null
  target_hyb_pts?: number | null
  target_hyb_cash?: number | null
}

describeIt('limpeza de alvo incompatível com a companhia (integração / Postgres real)', () => {
  let pool: Pool

  const criarRotina = async (id: string, airlines: string[], alvos: Alvos): Promise<void> => {
    await pool.query(
      `INSERT INTO ${SCHEMA}.routines (id, priority, target_cash, target_pts, target_hyb_pts, target_hyb_cash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        alvos.priority ?? 'cash',
        alvos.target_cash ?? null,
        alvos.target_pts ?? null,
        alvos.target_hyb_pts ?? null,
        alvos.target_hyb_cash ?? null,
      ],
    )
    for (const a of airlines) {
      await pool.query(`INSERT INTO ${SCHEMA}.routine_airlines (routine_id, airline) VALUES ($1, $2)`, [id, a])
    }
  }

  const ler = async (id: string) => {
    const { rows } = await pool.query(
      `SELECT priority, target_cash, target_pts, target_hyb_pts, target_hyb_cash
       FROM ${SCHEMA}.routines WHERE id = $1`, [id],
    )
    return rows[0] as Record<string, unknown>
  }

  const rodarMigration = async (): Promise<void> => {
    await pool.query(fs.readFileSync(MIGRATION, 'utf-8'))
  }

  beforeAll(async () => {
    // search_path SEM `public`, ao contrário dos outros testes de integração: o
    // SQL da migration referencia `routines` sem qualificar, e com `public` no
    // caminho uma tabela que faltasse aqui faria o UPDATE cair nas tabelas de
    // verdade. O schema precisa ser criado por uma conexão à parte, porque a
    // própria conexão do pool não consegue abrir com um search_path inexistente.
    const setup = new Pool({ connectionString: DB_URL })
    await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    await setup.end()

    pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA}` })
    // Espelha só as colunas que a regra toca — self-contained, sem FK.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.airlines (
        code      VARCHAR(20) PRIMARY KEY,
        has_cash  BOOLEAN NOT NULL DEFAULT true,
        has_pts   BOOLEAN NOT NULL DEFAULT false,
        has_hyb   BOOLEAN NOT NULL DEFAULT false
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routines (
        id              UUID PRIMARY KEY,
        priority        VARCHAR(10)   NOT NULL DEFAULT 'cash',
        target_cash     NUMERIC(10,2),
        target_pts      INTEGER,
        target_hyb_pts  INTEGER,
        target_hyb_cash NUMERIC(10,2)
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.routine_airlines (
        routine_id UUID        NOT NULL,
        airline    VARCHAR(20) NOT NULL,
        PRIMARY KEY (routine_id, airline)
      )`)
    await pool.query(`
      INSERT INTO ${SCHEMA}.airlines (code, has_cash, has_pts, has_hyb) VALUES
        ('azul',    true, true,  true),
        ('latam',   true, false, false),
        ('ryanair', true, false, false)
      ON CONFLICT (code) DO NOTHING`)
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await pool.end()
    }
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.routines, ${SCHEMA}.routine_airlines`)
  })

  const R1 = '00000000-0000-0000-0000-0000000000a1'
  const R2 = '00000000-0000-0000-0000-0000000000a2'

  it('apaga o alvo híbrido de rotina em companhia sem híbrido', async () => {
    // O caso real: 20.000 pts + R$400 numa rotina de LATAM.
    await criarRotina(R1, ['latam'], { target_hyb_pts: 20000, target_hyb_cash: 400 })
    await rodarMigration()

    const r = await ler(R1)
    expect(r.target_hyb_pts).toBeNull()
    expect(r.target_hyb_cash).toBeNull()
  })

  it('apaga os DOIS campos do híbrido mesmo quando só um estava preenchido', async () => {
    // Meio alvo híbrido não é alvo: deixar o par pela metade seria trocar um dado
    // errado por outro.
    await criarRotina(R1, ['ryanair'], { target_hyb_cash: 400 })
    await rodarMigration()

    const r = await ler(R1)
    expect(r.target_hyb_pts).toBeNull()
    expect(r.target_hyb_cash).toBeNull()
  })

  it('preserva o alvo híbrido quando a companhia precifica híbrido', async () => {
    await criarRotina(R1, ['azul'], { target_hyb_pts: 20000, target_hyb_cash: 400 })
    await rodarMigration()

    const r = await ler(R1)
    expect(Number(r.target_hyb_pts)).toBe(20000)
    expect(Number(r.target_hyb_cash)).toBe(400)
  })

  it('preserva quando AO MENOS UMA das companhias precifica — mesma regra da API', async () => {
    // [azul, latam] em pontos: a Azul avalia, a LATAM só não contribui. Limpar
    // aqui apagaria um alvo que funciona.
    await criarRotina(R1, ['azul', 'latam'], { target_pts: 15000 })
    await rodarMigration()

    expect(Number((await ler(R1)).target_pts)).toBe(15000)
  })

  it('apaga o alvo em pontos quando nenhuma das companhias tem pontos', async () => {
    await criarRotina(R1, ['latam', 'ryanair'], { target_pts: 15000 })
    await rodarMigration()

    expect((await ler(R1)).target_pts).toBeNull()
  })

  it('não encosta no alvo em dinheiro — toda companhia ativa publica dinheiro', async () => {
    await criarRotina(R1, ['latam'], { target_cash: 300, target_hyb_pts: 20000 })
    await rodarMigration()

    const r = await ler(R1)
    expect(Number(r.target_cash)).toBe(300)
    expect(r.target_hyb_pts).toBeNull()
  })

  it('prioridade impossível volta para dinheiro', async () => {
    // Sem isto a rotina fica inelegível para edição: a validação nova recusaria
    // qualquer alteração por causa de uma prioridade que ninguém precifica.
    await criarRotina(R1, ['latam'], { priority: 'hyb' })
    await rodarMigration()

    expect((await ler(R1)).priority).toBe('cash')
  })

  it('prioridade válida fica como está', async () => {
    await criarRotina(R1, ['azul'], { priority: 'hyb', target_hyb_pts: 20000, target_hyb_cash: 400 })
    await rodarMigration()

    expect((await ler(R1)).priority).toBe('hyb')
  })

  it('mexe só nas rotinas afetadas', async () => {
    await criarRotina(R1, ['latam'], { target_hyb_pts: 20000, target_hyb_cash: 400 })
    await criarRotina(R2, ['azul'],  { target_hyb_pts: 30000, target_hyb_cash: 500 })
    await rodarMigration()

    expect((await ler(R1)).target_hyb_pts).toBeNull()
    expect(Number((await ler(R2)).target_hyb_pts)).toBe(30000)
  })

  it('é idempotente: rodar de novo não muda mais nada', async () => {
    await criarRotina(R1, ['latam'], { priority: 'hyb', target_hyb_pts: 20000, target_hyb_cash: 400 })
    await rodarMigration()
    const depoisDaPrimeira = await ler(R1)
    await rodarMigration()

    expect(await ler(R1)).toEqual(depoisDaPrimeira)
  })
})
