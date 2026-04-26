import { describe, it, expect } from 'vitest'
import { FlightOffersRepository } from './FlightOffersRepository'

// Acessa o método privado via cast para testar isolado
const repo = new FlightOffersRepository(null as never)
const build = (date: string, time: string, ref?: string) =>
  (repo as any).buildTimestamp(date, time, ref)

describe('FlightOffersRepository.buildTimestamp', () => {
  it('combina data e hora no mesmo dia', () => {
    expect(build('2026-05-03', '08:30')).toBe('2026-05-03T08:30:00')
  })

  it('chegada no mesmo dia quando arrivalTime > departureTime', () => {
    expect(build('2026-05-03', '22:15', '08:30')).toBe('2026-05-03T22:15:00')
  })

  it('avança para o dia seguinte quando arrivalTime < departureTime (voo noturno)', () => {
    expect(build('2026-05-03', '01:30', '23:00')).toBe('2026-05-04T01:30:00')
  })

  it('avança para o dia seguinte em virada de mês', () => {
    expect(build('2026-05-31', '02:00', '23:45')).toBe('2026-06-01T02:00:00')
  })

  it('avança para o dia seguinte em virada de ano', () => {
    expect(build('2026-12-31', '03:00', '22:00')).toBe('2027-01-01T03:00:00')
  })

  it('mesmo horário de partida e chegada não avança o dia', () => {
    expect(build('2026-05-03', '10:00', '10:00')).toBe('2026-05-03T10:00:00')
  })
})
