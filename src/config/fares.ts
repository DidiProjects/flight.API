/**
 * How long a collected fare still counts as the current price.
 *
 * A snapshot does not become wrong by ageing, but it does become unverifiable:
 * once the job for that date stops succeeding, the last price it brought stays
 * the cheapest of the routine and nothing displaces it, because every other date
 * that keeps collecting is more expensive. Measured on 2026-08-24: the card
 * showed a fare from a date whose collection had stalled while five other dates
 * had been refreshed in the last hour, and re-running the routine could not fix
 * it — the old row simply kept winning the MIN.
 *
 * 48 hours is the window the evaluation cycle already used to decide what may
 * fire an alert. Sharing it is the point: the card must not show a price the
 * alert would refuse to act on.
 */
export const MAX_FARE_AGE_HOURS = 48
