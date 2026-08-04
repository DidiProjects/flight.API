import { describe, it, expect } from 'vitest'
import { RoutinesService } from './RoutinesService'
import { AirlineRow, RoutineRow } from '../../types'
import { IRoutinesRepository } from './interfaces/IRoutinesRepository'
import { IAirlinesRepository } from '../airlines/interfaces/IAirlinesRepository'
import { IAirportsRepository } from '../airports/interfaces/IAirportsRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'

/**
 * O furo que estes testes fecham: a validação de companhia vivia só na criação.
 * Criar a rotina numa companhia que suporta e depois TROCAR a companhia passava
 * batido — foi assim que nasceram rotinas com alvo híbrido em companhia sem
 * híbrido.
 */

const AIRLINES: Record<string, AirlineRow> = {
  azul:    { code: 'azul',    name: 'Azul',    currency: null, active: true, has_cash: true, has_pts: true,  has_hyb: true,  has_roundtrip: true },
  latam:   { code: 'latam',   name: 'LATAM',   currency: null, active: true, has_cash: true, has_pts: false, has_hyb: false, has_roundtrip: false },
  ryanair: { code: 'ryanair', name: 'Ryanair', currency: null, active: true, has_cash: true, has_pts: false, has_hyb: false, has_roundtrip: true },
}

/** Rotina híbrida de Azul — o ponto de partida do caso relatado. */
const rotinaHibridaAzul = (): RoutineRow => ({
  id: 'r1', user_id: 'u1', name: 'híbrida', airlines: ['azul'],
  origin: 'GRU', destination: 'CNF',
  outbound_start: '2026-09-21', outbound_end: '2026-09-21',
  trip_type: 'one_way', inbound_start: null, inbound_end: null,
  passengers: 1, currency: 'BRL',
  target_cash: null, target_pts: null, target_hyb_pts: 20000, target_hyb_cash: 400,
  margin: 0.1, priority: 'hyb',
  notification_modes: ['target'], notification_frequency: 'hourly', scheduled_time: null,
  cc_emails: [], is_active: true, created_at: new Date(), updated_at: new Date(),
})

function makeService(existing: RoutineRow) {
  let saved: Partial<RoutineRow> | null = null

  const routinesRepo = {
    findById: async () => existing,
    findByIdAdmin: async () => existing,
    update: async (_id: string, _u: string, fields: unknown) => { saved = fields as Partial<RoutineRow>; return existing },
    updateById: async (_id: string, fields: unknown) => { saved = fields as Partial<RoutineRow>; return existing },
    countByUser: async () => 0,
    create: async () => existing,
  } as unknown as IRoutinesRepository

  const airlinesRepo = {
    findByCode: async (code: string) => AIRLINES[code] ?? null,
  } as unknown as IAirlinesRepository

  const airportsRepo = {
    hasAirport: async () => true,
    getCurrency: async () => 'BRL',
  } as unknown as IAirportsRepository

  const faresRepo = { getKnownCurrency: async () => null } as unknown as IFlightFaresRepository

  return {
    svc: new RoutinesService(routinesRepo, airlinesRepo, airportsRepo, faresRepo),
    saved: () => saved,
  }
}

describe('RoutinesService.update — capacidade da companhia', () => {
  it('barra trocar a companhia de uma rotina híbrida para uma sem híbrido', async () => {
    const { svc } = makeService(rotinaHibridaAzul())
    // Só a companhia muda; prioridade e alvos continuam os da rotina.
    await expect(svc.update('r1', 'u1', { airlines: ['latam'] })).rejects.toThrow(/híbrido/)
  })

  it('deixa trocar para uma companhia que também precifica híbrido', async () => {
    const existing = rotinaHibridaAzul()
    const { svc } = makeService(existing)
    await expect(svc.update('r1', 'u1', { airlines: ['azul'] })).resolves.toBeTruthy()
  })

  it('deixa trocar a companhia quando os alvos incompatíveis saem no mesmo request', async () => {
    // A edição é avaliada pelo estado FINAL: limpar o híbrido e passar a dinheiro
    // na mesma chamada é uma rotina válida para a LATAM.
    const { svc } = makeService(rotinaHibridaAzul())
    await expect(svc.update('r1', 'u1', {
      airlines: ['latam'], priority: 'cash', targetHybPts: null, targetHybCash: null, targetCash: 300,
    })).resolves.toBeTruthy()
  })

  it('barra ligar prioridade em pontos numa rotina de companhia sem pontos', async () => {
    const existing = { ...rotinaHibridaAzul(), airlines: ['latam'], priority: 'cash' as const, target_hyb_pts: null, target_hyb_cash: null }
    const { svc } = makeService(existing)
    // Nem a companhia muda aqui: é a prioridade que passa a pedir o que a
    // companhia atual não precifica.
    await expect(svc.update('r1', 'u1', { priority: 'pts' })).rejects.toThrow(/pontos/)
  })

  it('barra trocar para companhia sem busca ida-e-volta numa rotina round_trip', async () => {
    const existing: RoutineRow = {
      ...rotinaHibridaAzul(),
      trip_type: 'round_trip', inbound_start: '2026-09-25', inbound_end: '2026-09-25',
      priority: 'cash', target_hyb_pts: null, target_hyb_cash: null, target_cash: 500,
    }
    const { svc } = makeService(existing)
    await expect(svc.update('r1', 'u1', { airlines: ['latam'] })).rejects.toThrow(/ida e volta/)
    await expect(svc.update('r1', 'u1', { airlines: ['ryanair'] })).resolves.toBeTruthy()
  })
})

describe('RoutinesService.adminUpdateRoutine — mesmas regras', () => {
  it('admin também não consegue deixar alvo híbrido em companhia sem híbrido', async () => {
    const { svc } = makeService(rotinaHibridaAzul())
    await expect(svc.adminUpdateRoutine('r1', { airlines: ['latam'] })).rejects.toThrow(/híbrido/)
  })

  it('admin também não escapa da regra de preço do round-trip', async () => {
    const existing: RoutineRow = {
      ...rotinaHibridaAzul(),
      trip_type: 'round_trip', inbound_start: '2026-09-25', inbound_end: '2026-09-25',
      priority: 'cash', target_hyb_pts: null, target_hyb_cash: null,
    }
    const { svc } = makeService(existing)
    await expect(svc.adminUpdateRoutine('r1', { priority: 'pts' })).rejects.toThrow(/dinheiro/)
  })
})
