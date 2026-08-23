import { Pool } from 'pg'
import { IFareHistoryRepository } from './interfaces/IFareHistoryRepository'

/**
 * One statement, because the three steps have to see the same snapshot: derive
 * the itineraries of the run, upsert them, then either extend the current price
 * segment or open a new one. Split across round trips, a concurrent callback
 * could open two segments for the same price.
 *
 * The timestamp comes from `MAX(scraped_at)` of the run itself, not from the
 * clock: the segment window then means "when the price was collected", and
 * replaying a callback is a no-op instead of a fake observation.
 */
const RECORD_RUN = `
WITH run AS (
  SELECT MAX(scraped_at) AS observed_at FROM flight_fares WHERE request_id = $1
),
-- Round-trip: the PAIR is the product, and it is priced as the airline sells it —
-- bundle when there is one, otherwise outbound plus the return priced under that
-- outbound. Same rule as getCurrentBestPair; changing one without the other makes
-- the chart disagree with the card.
pairs AS (
  SELECT DISTINCT ON (o.airline, o.origin, o.destination, o.flight_number, o.flight_date, i.flight_number, i.flight_date)
    o.airline,
    'round_trip'::varchar(10) AS trip_type,
    o.origin, o.destination,
    o.flight_number AS outbound_flight_number,
    o.flight_date   AS outbound_date,
    i.flight_number AS inbound_flight_number,
    i.flight_date   AS inbound_date,
    o.currency,
    -- The bundle is charged in the outbound's market, so it needs no currency
    -- agreement; the sum of two legs does. Different currencies fall back to the
    -- frozen Real below instead of adding units that do not add.
    COALESCE(o.bundle_cash,     CASE WHEN o.currency = i.currency THEN o.fare_cash     + i.fare_cash     END) AS amount_cash,
    COALESCE(o.bundle_pts,      o.fare_pts      + i.fare_pts)      AS amount_pts,
    COALESCE(o.bundle_hyb_pts,  o.fare_hyb_pts  + i.fare_hyb_pts)  AS amount_hyb_pts,
    COALESCE(o.bundle_hyb_cash, CASE WHEN o.currency = i.currency THEN o.fare_hyb_cash + i.fare_hyb_cash END) AS amount_hyb_cash,
    COALESCE(o.bundle_cash     * o.fx_rate, o.fare_cash_brl     + i.fare_cash_brl)     AS amount_cash_brl,
    COALESCE(o.bundle_hyb_cash * o.fx_rate, o.fare_hyb_cash_brl + i.fare_hyb_cash_brl) AS amount_hyb_cash_brl,
    o.fx_rate, o.fx_rate_date
  FROM flight_fares o
  JOIN flight_fares i
    ON  i.request_id = o.request_id
    AND i.is_return
    AND i.airline     = o.airline
    AND i.return_date = o.return_date
    AND i.paired_outbound_flight = o.flight_number
    AND i.flight_number IS NOT NULL
    -- A "return" with the outbound's own route is the outbound list read as
    -- returns; pairing it would add two legs in the same direction.
    AND NOT (i.origin = o.origin AND i.destination = o.destination)
  WHERE o.request_id = $1
    AND NOT o.is_return
    AND o.return_date IS NOT NULL
    AND o.flight_number IS NOT NULL
  ORDER BY o.airline, o.origin, o.destination, o.flight_number, o.flight_date, i.flight_number, i.flight_date, o.scraped_at DESC
),
singles AS (
  SELECT DISTINCT ON (airline, origin, destination, flight_number, flight_date)
    airline,
    'one_way'::varchar(10) AS trip_type,
    origin, destination,
    flight_number AS outbound_flight_number,
    flight_date   AS outbound_date,
    NULL::varchar(20) AS inbound_flight_number,
    NULL::date        AS inbound_date,
    currency,
    fare_cash, fare_pts, fare_hyb_pts, fare_hyb_cash,
    fare_cash_brl, fare_hyb_cash_brl, fx_rate, fx_rate_date
  FROM flight_fares
  WHERE request_id = $1
    AND return_date IS NULL
    AND NOT is_return
    AND flight_number IS NOT NULL
  ORDER BY airline, origin, destination, flight_number, flight_date, scraped_at DESC
),
-- An offer with no price in any dimension is not an offer: it would create an
-- itinerary whose series never starts.
priced AS (
  SELECT * FROM (SELECT * FROM pairs UNION ALL SELECT * FROM singles) o
  WHERE o.amount_cash IS NOT NULL OR o.amount_pts IS NOT NULL
     OR o.amount_hyb_pts IS NOT NULL OR o.amount_hyb_cash IS NOT NULL
),
itin AS (
  INSERT INTO fare_itineraries
    (airline, trip_type, origin, destination,
     outbound_flight_number, outbound_date, inbound_flight_number, inbound_date,
     currency, first_seen_at, last_seen_at)
  SELECT p.airline, p.trip_type, p.origin, p.destination,
         p.outbound_flight_number, p.outbound_date, p.inbound_flight_number, p.inbound_date,
         p.currency, r.observed_at, r.observed_at
  FROM priced p CROSS JOIN run r
  ON CONFLICT (airline, trip_type, origin, destination,
               outbound_flight_number, outbound_date, inbound_flight_number, inbound_date)
  DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                currency     = EXCLUDED.currency
  RETURNING id, airline, trip_type, origin, destination,
            outbound_flight_number, outbound_date, inbound_flight_number, inbound_date
),
target AS (
  SELECT it.id AS itinerary_id, p.*, r.observed_at
  FROM itin it
  JOIN priced p
    ON  p.airline     = it.airline
    AND p.trip_type   = it.trip_type
    AND p.origin      = it.origin
    AND p.destination = it.destination
    AND p.outbound_flight_number = it.outbound_flight_number
    AND p.outbound_date          = it.outbound_date
    -- IS NOT DISTINCT FROM, not '=': on a one-way both sides are NULL and '='
    -- would match nothing, losing every single-leg itinerary.
    AND p.inbound_flight_number IS NOT DISTINCT FROM it.inbound_flight_number
    AND p.inbound_date          IS NOT DISTINCT FROM it.inbound_date
  CROSS JOIN run r
),
current_seg AS (
  SELECT DISTINCT ON (h.itinerary_id)
    h.id, h.itinerary_id, h.currency,
    h.amount_cash, h.amount_pts, h.amount_hyb_pts, h.amount_hyb_cash
  FROM fare_price_history h
  WHERE h.itinerary_id IN (SELECT itinerary_id FROM target)
  ORDER BY h.itinerary_id, h.observed_from DESC
),
-- Price identical to the open segment: the segment just got wider. The strict
-- '>' makes a replayed callback change nothing instead of inflating the count.
unchanged AS (
  UPDATE fare_price_history h
     SET last_seen_at      = t.observed_at,
         observation_count = h.observation_count + 1
    FROM current_seg c
    JOIN target t ON t.itinerary_id = c.itinerary_id
   WHERE h.id = c.id
     AND (c.currency, c.amount_cash, c.amount_pts, c.amount_hyb_pts, c.amount_hyb_cash)
         IS NOT DISTINCT FROM
         (t.currency, t.amount_cash, t.amount_pts, t.amount_hyb_pts, t.amount_hyb_cash)
     AND t.observed_at > h.last_seen_at
  RETURNING h.itinerary_id
)
INSERT INTO fare_price_history
  (itinerary_id, currency, amount_cash, amount_pts, amount_hyb_pts, amount_hyb_cash,
   amount_cash_brl, amount_hyb_cash_brl, fx_rate, fx_rate_date, observed_from, last_seen_at)
SELECT t.itinerary_id, t.currency, t.amount_cash, t.amount_pts, t.amount_hyb_pts, t.amount_hyb_cash,
       t.amount_cash_brl, t.amount_hyb_cash_brl, t.fx_rate, t.fx_rate_date,
       t.observed_at, t.observed_at
FROM target t
WHERE t.itinerary_id NOT IN (SELECT itinerary_id FROM unchanged)
ON CONFLICT (itinerary_id, observed_from) DO NOTHING
`

export class FareHistoryRepository implements IFareHistoryRepository {
  constructor(private readonly db: Pool) {}

  async recordRun(requestId: string): Promise<number> {
    const { rowCount } = await this.db.query(RECORD_RUN, [requestId])
    return rowCount ?? 0
  }

  async cleanupNotSeenSince(days: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM fare_itineraries WHERE last_seen_at < NOW() - ($1 || ' days')::interval`,
      [days],
    )
    return rowCount ?? 0
  }
}
