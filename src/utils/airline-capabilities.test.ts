import { describe, it, expect } from 'vitest'
import { airlineCapabilityError, AirlineCapabilities } from './airline-capabilities'

const cia = (code: string, caps: Partial<AirlineCapabilities> = {}): AirlineCapabilities => ({
  code,
  has_cash: true,
  has_pts: false,
  has_hyb: false,
  has_roundtrip: false,
  ...caps,
})

const azul = cia('azul', { has_pts: true, has_hyb: true, has_roundtrip: true })
const ryanair = cia('ryanair', { has_roundtrip: true })
const latam = cia('latam')

describe('airlineCapabilityError', () => {
  it('aceita rotina em dinheiro numa companhia que só tem dinheiro', () => {
    expect(airlineCapabilityError([ryanair], { priority: 'cash', targetCash: 300 })).toBeNull()
  })

  it('barra alvo híbrido em companhia sem híbrido', () => {
    // The case that actually showed up: a 20,000 pts + R$400 target on a
    // Ryanair/BA/LATAM routine, all with has_hyb = false.
    const err = airlineCapabilityError([latam], { priority: 'cash', targetHybPts: 20000, targetHybCash: 400 })
    expect(err).toMatch(/híbrido/)
  })

  it('barra alvo híbrido mesmo quando só um dos dois campos veio', () => {
    expect(airlineCapabilityError([latam], { targetHybCash: 400 })).toMatch(/híbrido/)
    expect(airlineCapabilityError([latam], { targetHybPts: 20000 })).toMatch(/híbrido/)
  })

  it('barra prioridade em pontos quando nenhuma companhia tem pontos', () => {
    expect(airlineCapabilityError([latam, ryanair], { priority: 'pts' })).toMatch(/pontos/)
  })

  it('aceita a dimensão quando AO MENOS UMA companhia a precifica', () => {
    // [azul, latam] with priority on points: Azul alerts, LATAM simply does not
    // contribute. Nothing is corrupted, so there is no reason to block.
    expect(airlineCapabilityError([azul, latam], { priority: 'pts', targetPts: 15000 })).toBeNull()
  })

  it('exige ida-e-volta de TODAS as companhias, não de uma', () => {
    // Different from the price dimension: a pair job on an airline with no RT search
    // comes back with loose legs and no total — false pair data.
    expect(airlineCapabilityError([azul, latam], { tripType: 'round_trip' })).toMatch(/latam/)
    expect(airlineCapabilityError([azul, ryanair], { tripType: 'round_trip' })).toBeNull()
  })

  it('não reclama de ida-e-volta numa rotina só-ida', () => {
    expect(airlineCapabilityError([latam], { tripType: 'one_way', priority: 'cash' })).toBeNull()
  })

  it('não reclama quando a rotina não pede dimensão nenhuma', () => {
    expect(airlineCapabilityError([latam], {})).toBeNull()
  })

  it('sem companhia não há o que validar', () => {
    expect(airlineCapabilityError([], { targetHybPts: 20000 })).toBeNull()
  })

  it('nomeia a companhia que falta na mensagem de ida-e-volta', () => {
    expect(airlineCapabilityError([latam], { tripType: 'round_trip' })).toBe(
      "Companhia 'latam' não suporta busca de ida e volta",
    )
  })
})
