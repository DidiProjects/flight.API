import { describe, it, expect } from 'vitest'
import { MAX_ROUNDTRIP_SPAN_MONTHS, maxInboundDate, isValidRoundTripPair } from './roundtrip'

const iso = (d: Date) => d.toISOString().slice(0, 10)

describe('roundtrip span', () => {
  it('o teto é de 3 meses', () => {
    expect(MAX_ROUNDTRIP_SPAN_MONTHS).toBe(3)
  })

  describe('maxInboundDate', () => {
    it('soma 3 meses mantendo o dia', () => {
      expect(iso(maxInboundDate('2026-09-10'))).toBe('2026-12-10')
    })

    it('recua para o último dia quando o mês destino é mais curto', () => {
      expect(iso(maxInboundDate('2026-01-31'))).toBe('2026-04-30')
    })

    it('atravessa a virada de ano e o fevereiro curto', () => {
      expect(iso(maxInboundDate('2026-11-30'))).toBe('2027-02-28')
    })

    it('aceita Date além de string', () => {
      expect(iso(maxInboundDate(new Date('2026-09-10T00:00:00Z')))).toBe('2026-12-10')
    })
  })

  describe('isValidRoundTripPair', () => {
    it('aceita volta no mesmo dia da ida', () => {
      expect(isValidRoundTripPair('2026-09-10', '2026-09-10')).toBe(true)
    })

    it('aceita volta dentro da janela', () => {
      expect(isValidRoundTripPair('2026-09-10', '2026-09-20')).toBe(true)
    })

    it('aceita volta exatamente no teto', () => {
      expect(isValidRoundTripPair('2026-09-10', '2026-12-10')).toBe(true)
    })

    it('rejeita volta um dia depois do teto', () => {
      expect(isValidRoundTripPair('2026-09-10', '2026-12-11')).toBe(false)
    })

    it('rejeita volta anterior à ida', () => {
      expect(isValidRoundTripPair('2026-09-10', '2026-09-09')).toBe(false)
    })
  })
})
