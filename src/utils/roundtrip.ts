/**
 * Time ceiling between the outbound and the return of a round-trip routine.
 * Product decision (2026-07-24): not configurable per routine.
 */
export const MAX_ROUNDTRIP_SPAN_MONTHS = 3

function toUtcDate(v: string | Date): Date {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
  return new Date(`${s}T00:00:00Z`)
}

/** Latest return date for an outbound — past it the pair is invalid. */
export function maxInboundDate(outbound: string | Date): Date {
  const d = toUtcDate(outbound)
  const limit = new Date(d)
  limit.setUTCMonth(limit.getUTCMonth() + MAX_ROUNDTRIP_SPAN_MONTHS)
  // setUTCMonth overflows when the day does not exist in the target month (31/01
  // + 1 month = 03/03). Step back to the last day of the intended month.
  if (limit.getUTCDate() !== d.getUTCDate()) limit.setUTCDate(0)
  return limit
}

/** A pair (outbound, return) is valid when the return neither precedes the outbound nor passes the ceiling. */
export function isValidRoundTripPair(outbound: string | Date, inbound: string | Date): boolean {
  const out = toUtcDate(outbound)
  const inb = toUtcDate(inbound)
  return inb >= out && inb <= maxInboundDate(out)
}

/**
 * Is there at least one valid pair between the two windows? Used in routine
 * validation: windows that close no pair would scrape without ever evaluating.
 *
 * A pair exists ⟺ some outbound is ≤ the last return AND some return fits the
 * ceiling of the last outbound — `outStart <= inEnd` and `inStart <= maxInbound(outEnd)`.
 */
export function windowsCanFormValidPair(
  outStart: string | Date,
  outEnd: string | Date,
  inStart: string | Date,
  inEnd: string | Date,
): boolean {
  return toUtcDate(outStart) <= toUtcDate(inEnd) && toUtcDate(inStart) <= maxInboundDate(outEnd)
}

/**
 * Round-trip only totals in CASH (decision of 2026-08-01).
 *
 * The outbound is selected in Real on purpose — on points Azul requires a TudoAzul
 * login and the return becomes unreachable. Once the outbound fare is chosen, the
 * airline stops offering the currency switch on the returns list, and the returns
 * come back without `fare_pts`/`fare_hyb_*`.
 *
 * Without both legs in the same dimension there is no total, and an RT routine on
 * points or hybrid would never alert — it would stay on promising a notice that
 * does not come. Blocking on entry is honest; accepting and going quiet is not.
 *
 * A temporary measure: it falls when points collection for the return is solved
 * (bundle/phase 2, or another airline that publishes the return in points).
 */
export function roundTripPricingError(d: {
  priority?: string | null
  targetPts?: number | null
  targetHybPts?: number | null
  targetHybCash?: number | null
}): string | null {
  if (d.priority === 'pts' || d.priority === 'hyb') {
    return 'Rotina de ida e volta só aceita prioridade em dinheiro: a companhia não publica o preço da volta em pontos'
  }
  if (d.targetPts != null || d.targetHybPts != null || d.targetHybCash != null) {
    return 'Rotina de ida e volta só aceita alvo em dinheiro (targetCash): sem o preço da volta em pontos o alvo nunca seria avaliado'
  }
  return null
}
