import { describe, it, expect, vi, afterEach } from 'vitest'
import { calcNextRunAt, calcBackoffNextRunAt } from '../../services/scheduler/SchedulerService'

// ── helpers ────────────────────────────────────────────────────────────────────

function addDaysToNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('calcNextRunAt', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('≤7 dias → intervalo de 1 hora', () => {
    vi.useFakeTimers()
    const flightDate = addDaysToNow(5)
    const result = calcNextRunAt(flightDate)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeCloseTo(1 * 60 * 60 * 1000, -4)
  })

  it('≤14 dias → intervalo de 2 horas', () => {
    vi.useFakeTimers()
    const flightDate = addDaysToNow(10)
    const result = calcNextRunAt(flightDate)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeCloseTo(2 * 60 * 60 * 1000, -4)
  })

  it('≤45 dias (sweet spot) → intervalo de 3 horas', () => {
    vi.useFakeTimers()
    const flightDate = addDaysToNow(30)
    const result = calcNextRunAt(flightDate)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeCloseTo(3 * 60 * 60 * 1000, -4)
  })

  it('≤90 dias → intervalo de 6 horas', () => {
    vi.useFakeTimers()
    const flightDate = addDaysToNow(60)
    const result = calcNextRunAt(flightDate)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeCloseTo(6 * 60 * 60 * 1000, -4)
  })

  it('>90 dias → intervalo de 12 horas', () => {
    vi.useFakeTimers()
    const flightDate = addDaysToNow(120)
    const result = calcNextRunAt(flightDate)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeCloseTo(12 * 60 * 60 * 1000, -4)
  })
})

describe('calcBackoffNextRunAt', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retry 0 → ~1 minuto (60000ms + jitter ≤ 30s)', () => {
    vi.useFakeTimers()
    const result = calcBackoffNextRunAt(0)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeGreaterThanOrEqual(60_000)
    expect(diffMs).toBeLessThan(60_000 + 30_000 + 1)
  })

  it('retry 1 → ~2 minutos (120000ms + jitter ≤ 30s)', () => {
    vi.useFakeTimers()
    const result = calcBackoffNextRunAt(1)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeGreaterThanOrEqual(120_000)
    expect(diffMs).toBeLessThan(120_000 + 30_000 + 1)
  })

  it('retry 2 → ~4 minutos (240000ms + jitter ≤ 30s)', () => {
    vi.useFakeTimers()
    const result = calcBackoffNextRunAt(2)
    const diffMs = result.getTime() - Date.now()
    expect(diffMs).toBeGreaterThanOrEqual(240_000)
    expect(diffMs).toBeLessThan(240_000 + 30_000 + 1)
  })

  it('retry alto → capped em 30 minutos + jitter', () => {
    vi.useFakeTimers()
    const result = calcBackoffNextRunAt(10)
    const diffMs = result.getTime() - Date.now()
    const CAP_MS = 30 * 60_000
    expect(diffMs).toBeGreaterThanOrEqual(CAP_MS)
    expect(diffMs).toBeLessThan(CAP_MS + 30_000 + 1)
  })
})
