/**
 * Money arithmetic in cents.
 *
 * A fare is a decimal quantity and JS adds it in binary floating point:
 * `1178.54 + 1188.61` is `2367.1499999999996`, not `2367.15`. The bank stores it
 * as `NUMERIC(12,2)` and hands back the rounded `"2367.15"`, so the same price
 * computed in the process and read from a column are two different numbers.
 *
 * Measured in production on 2026-08-23: the routine record gate compares the
 * pair total against the watermark, and the 4.5e-13 gap made every new date at
 * an identical price look like a new record — nine e-mails, all with the same
 * price, one per collected date.
 *
 * Everything here goes through integer cents, which is exactly what the column
 * holds.
 */

/**
 * Cents of a value in Real, rounded the way `NUMERIC(12,2)` rounds.
 *
 * The `toFixed(6)` is not decoration: `1.005 * 100` is `100.49999999999999`, so
 * rounding straight away gives 100 cents where the bank stores 101. Trimming the
 * binary dust first — six decimals is far below the cent and far above the
 * error — makes the two agree.
 */
export const toCents = (value: number): number => Math.round(Number((value * 100).toFixed(6)))

export const fromCents = (cents: number): number => cents / 100

/**
 * Sum that lands on the same number the bank would store.
 *
 * `sumMoney(1178.54, 1188.61)` is `2367.15`, not `2367.1499999999996`.
 *
 * Rounds ONCE, at the end, which is what `NUMERIC` addition does. Rounding each
 * parcel first would turn `1.005 + 2.005` into 3.02, where the column says 3.01.
 */
export const sumMoney = (...values: number[]): number =>
  fromCents(toCents(values.reduce((acc, value) => acc + value, 0)))

/**
 * Is `candidate` cheaper than `reference` by at least `margin` (a fraction)?
 *
 * The margin is what keeps a one-cent drop from being reported as news: with
 * `margin = 0.01`, a fare only counts as better when it undercuts the reference
 * by 1%. The comparison runs in cents, so a price identical to one that came
 * from the bank is never mistaken for an improvement.
 *
 * A non-finite reference means "nothing to beat" (no watermark yet) and any
 * candidate passes.
 */
export function isCheaperBy(candidate: number, reference: number, margin: number): boolean {
  if (!Number.isFinite(candidate)) return false
  if (!Number.isFinite(reference)) return true
  const referenceCents = toCents(reference)
  // The threshold is a whole cent, and beating the reference by at least one of
  // them is the floor of the rule — `margin = 0` still rejects an equal price.
  const threshold = Math.min(Math.floor(referenceCents * (1 - margin)), referenceCents - 1)
  return toCents(candidate) <= threshold
}
