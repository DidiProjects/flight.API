import { describe, it, expect } from 'vitest'
import { createRoutineSchema } from './schema'

const base = {
  name: 'Rotina',
  airlines: ['azul'],
  origin: 'VCP',
  destination: 'LIS',
  outboundStart: '2026-08-01',
  outboundEnd: '2026-08-10',
  notificationModes: ['target'],
  notificationFrequency: 'daily',
  targetCash: 2000,
}

const parse = (o: Record<string, unknown>) => createRoutineSchema.safeParse({ ...base, ...o })
const errorOn = (r: ReturnType<typeof parse>) =>
  r.success ? null : r.error.issues[0].message

// Ida-e-volta tem teto de 5 dias por janela, então o `base` (9 dias de ida, que
// é legítimo em só-ida) não serve de ponto de partida para os casos de par.
const rtIda = { outboundStart: '2026-08-01', outboundEnd: '2026-08-05' }

describe('createRoutineSchema — round-trip', () => {
  it('one_way é o default e dispensa janela de volta', () => {
    const r = parse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.tripType).toBe('one_way')
  })

  it('round_trip com janela de volta válida passa', () => {
    expect(parse({
      ...rtIda, tripType: 'round_trip', inboundStart: '2026-08-20', inboundEnd: '2026-08-25',
    }).success).toBe(true)
  })

  it('round_trip sem janela de volta é rejeitado', () => {
    expect(errorOn(parse({ ...rtIda, tripType: 'round_trip' })))
      .toMatch(/obrigatórios quando tripType é round_trip/)
  })

  it('one_way com janela de volta é rejeitado', () => {
    expect(errorOn(parse({ inboundStart: '2026-08-20', inboundEnd: '2026-08-25' })))
      .toMatch(/só são aceitos quando tripType é round_trip/)
  })

  it('volta antes da ida é rejeitada', () => {
    expect(errorOn(parse({
      ...rtIda, tripType: 'round_trip', inboundStart: '2026-07-20', inboundEnd: '2026-07-25',
    }))).toMatch(/não pode começar antes da ida/)
  })

  it('nenhum par cabendo no teto de 3 meses é rejeitado', () => {
    expect(errorOn(parse({
      ...rtIda, tripType: 'round_trip', inboundStart: '2026-12-01', inboundEnd: '2026-12-05',
    }))).toMatch(/limite de 3 meses/)
  })

  it('par no limite exato de 3 meses passa', () => {
    expect(parse({
      ...rtIda, tripType: 'round_trip', inboundStart: '2026-11-05', inboundEnd: '2026-11-05',
    }).success).toBe(true)
  })
})

/**
 * O teto de 5 dias existe porque a coleta RT é por PAR: o número de buscas é o
 * PRODUTO das janelas. Com 30 dias dos dois lados seriam 900 buscas por ciclo e
 * por companhia; com 5, no máximo 25.
 */
describe('createRoutineSchema — teto de 5 dias no round-trip', () => {
  const volta = { inboundStart: '2026-08-20', inboundEnd: '2026-08-24' }

  it('janela de ida de 5 dias passa', () => {
    expect(parse({
      tripType: 'round_trip', outboundStart: '2026-08-01', outboundEnd: '2026-08-06', ...volta,
    }).success).toBe(true)
  })

  it('janela de ida de 6 dias é rejeitada', () => {
    expect(errorOn(parse({
      tripType: 'round_trip', outboundStart: '2026-08-01', outboundEnd: '2026-08-07', ...volta,
    }))).toMatch(/ida não pode exceder 5 dias/)
  })

  it('janela de volta de 6 dias é rejeitada', () => {
    expect(errorOn(parse({
      ...rtIda, tripType: 'round_trip', inboundStart: '2026-08-20', inboundEnd: '2026-08-26',
    }))).toMatch(/volta não pode exceder 5 dias/)
  })

  it('só-ida continua aceitando 30 dias', () => {
    // O teto é do par, não do produto: uma perna avulsa não multiplica nada.
    expect(parse({ outboundStart: '2026-08-01', outboundEnd: '2026-08-31' }).success).toBe(true)
  })

  it('só-ida com 31 dias continua rejeitada', () => {
    expect(errorOn(parse({ outboundStart: '2026-08-01', outboundEnd: '2026-09-01' })))
      .toMatch(/ida não pode exceder 30 dias/)
  })
})

/**
 * Round-trip só fecha total em dinheiro: a companhia não publica o preço da
 * volta em pontos (a ida é escolhida em reais, e aí some o seletor de moeda da
 * lista de voltas). Aceitar pts/hyb criaria rotina ligada que nunca alerta.
 */
describe('createRoutineSchema — round-trip só em dinheiro', () => {
  const rt = { ...rtIda, tripType: 'round_trip', inboundStart: '2026-08-20', inboundEnd: '2026-08-25' }

  it('prioridade em pontos é rejeitada no round-trip', () => {
    expect(errorOn(parse({ ...rt, priority: 'pts', targetPts: 30000, targetCash: null })))
      .toMatch(/só aceita prioridade em dinheiro/)
  })

  it('prioridade híbrida é rejeitada no round-trip', () => {
    expect(errorOn(parse({ ...rt, priority: 'hyb', targetHybPts: 10000, targetHybCash: 500, targetCash: null })))
      .toMatch(/só aceita prioridade em dinheiro/)
  })

  it('alvo em pontos é rejeitado mesmo com prioridade em dinheiro', () => {
    // A prioridade manda no que é exibido, mas o alvo em pontos seria avaliado
    // contra um total que nunca existe.
    expect(errorOn(parse({ ...rt, priority: 'cash', targetPts: 30000 })))
      .toMatch(/só aceita alvo em dinheiro/)
  })

  it('one_way continua aceitando pontos e híbrido', () => {
    // A restrição é do par, não do produto: perna avulsa tem preço em pontos.
    expect(parse({ priority: 'pts', targetPts: 30000, targetCash: null }).success).toBe(true)
    expect(parse({ priority: 'hyb', targetHybPts: 10000, targetHybCash: 500, targetCash: null }).success).toBe(true)
  })

  it('round-trip em dinheiro segue passando', () => {
    expect(parse({ ...rt, priority: 'cash', targetCash: 2000 }).success).toBe(true)
  })
})
