/**
 * Teto de tempo entre a ida e a volta de uma rotina round-trip.
 * Decisão de produto (2026-07-24): não é configurável por rotina.
 */
export const MAX_ROUNDTRIP_SPAN_MONTHS = 3

function toUtcDate(v: string | Date): Date {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
  return new Date(`${s}T00:00:00Z`)
}

/** Data limite da volta para uma ida — a partir dela o par é inválido. */
export function maxInboundDate(outbound: string | Date): Date {
  const d = toUtcDate(outbound)
  const limit = new Date(d)
  limit.setUTCMonth(limit.getUTCMonth() + MAX_ROUNDTRIP_SPAN_MONTHS)
  // setUTCMonth transborda quando o dia não existe no mês destino (31/01 + 1 mês
  // = 03/03). Recua para o último dia do mês pretendido.
  if (limit.getUTCDate() !== d.getUTCDate()) limit.setUTCDate(0)
  return limit
}

/** Um par (ida, volta) é válido quando a volta não antecede a ida nem passa do teto. */
export function isValidRoundTripPair(outbound: string | Date, inbound: string | Date): boolean {
  const out = toUtcDate(outbound)
  const inb = toUtcDate(inbound)
  return inb >= out && inb <= maxInboundDate(out)
}

/**
 * Existe ao menos um par válido entre as duas janelas? Usado na validação da
 * rotina: janelas que não fecham nenhum par gerariam scrape sem nunca avaliar.
 *
 * Existe par ⟺ alguma ida é ≤ a última volta E alguma volta cabe no teto da
 * última ida — ou seja `outStart <= inEnd` e `inStart <= maxInbound(outEnd)`.
 */
export function windowsCanFormValidPair(
  outStart: string | Date,
  outEnd: string | Date,
  inStart: string | Date,
  inEnd: string | Date,
): boolean {
  return toUtcDate(outStart) <= toUtcDate(inEnd) && toUtcDate(inStart) <= maxInboundDate(outEnd)
}
