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

  // Intervalo base ± jitter de 20% (desincroniza grids; ver calcNextRunAt).
  const expectWithinJitter = (diffMs: number, baseMs: number) => {
    expect(diffMs).toBeGreaterThanOrEqual(baseMs * 0.8)
    expect(diffMs).toBeLessThanOrEqual(baseMs * 1.2)
  }

  it('≤45 dias → ~4 horas (±20%)', () => {
    vi.useFakeTimers()
    const result = calcNextRunAt(addDaysToNow(30))
    expectWithinJitter(result.getTime() - Date.now(), 4 * 60 * 60 * 1000)
  })

  it('46–90 dias → ~8 horas (±20%)', () => {
    vi.useFakeTimers()
    const result = calcNextRunAt(addDaysToNow(60))
    expectWithinJitter(result.getTime() - Date.now(), 8 * 60 * 60 * 1000)
  })

  it('>90 dias → ~12 horas (±20%)', () => {
    vi.useFakeTimers()
    const result = calcNextRunAt(addDaysToNow(120))
    expectWithinJitter(result.getTime() - Date.now(), 12 * 60 * 60 * 1000)
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
