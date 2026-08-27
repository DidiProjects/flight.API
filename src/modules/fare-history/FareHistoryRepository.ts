import { Pool } from 'pg'
import {
  DeleteHistoryResult,
  FareHistoryBucket,
  FareHistoryQuery,
  FareHistoryRange,
  FareHistorySeries,
  IFareHistoryRepository,
} from './interfaces/IFareHistoryRepository'

/**
 * Span and resolution of each range. A closed table, never user input: these go
 * into the SQL as `interval` parameters and a free string here would be an
 * injection point.
 */
const RANGE_SPEC: Record<FareHistoryRange, { span: string; step: string }> = {
  day:     { span: '24 hours', step: '1 hour' },
  month:   { span: '30 days',  step: '1 day'  },
  '6m':    { span: '180 days', step: '7 days' },
}

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

/**
 * An itinerary belongs to a routine by ROUTE and trip type, the same rule
 * `belongsToRoutine` applies to jobs and runs — spelled out again here because
 * the columns are not the same ones: `outbound_date`/`inbound_date` instead of
 * `flight_date`/`return_date`, and the trip type is on the row itself.
 */
const itineraryBelongsToRoutine = (alias: string, routineIdComparison: string) => `
  EXISTS (
    SELECT 1 FROM routines r
    JOIN routine_airlines ra ON ra.routine_id = r.id
    WHERE r.id ${routineIdComparison}
      AND ra.airline    = ${alias}.airline
      AND r.origin      = ${alias}.origin
      AND r.destination = ${alias}.destination
      AND r.trip_type   = ${alias}.trip_type
      AND ${alias}.outbound_date BETWEEN r.outbound_start AND r.outbound_end
      AND (
        ${alias}.inbound_date IS NULL
        OR ${alias}.inbound_date BETWEEN r.inbound_start AND r.inbound_end
      )
  )`

export class FareHistoryRepository implements IFareHistoryRepository {
  constructor(private readonly db: Pool) {}

  async getSeries(query: FareHistoryQuery, range: FareHistoryRange): Promise<FareHistorySeries> {
    const { span, step } = RANGE_SPEC[range]
    const params: unknown[] = [
      query.airlines, query.origin, query.destination,
      query.dateFrom, query.dateTo, span, step,
    ]

    // A routine with a return window reads round-trip itineraries, whose price is
    // the pair total; one without reads one-way. Mixing them would put the total
    // of a trip and the price of a leg in the same series.
    const tripFilter = query.inbound
      ? `AND i.trip_type = 'round_trip' AND i.inbound_date BETWEEN $8 AND $9`
      : `AND i.trip_type = 'one_way'`
    if (query.inbound) params.push(query.inbound.from, query.inbound.to)

    const { rows } = await this.db.query<FareHistoryBucket & { currency: string | null; airline: string | null }>(`
      WITH bounds AS (
        SELECT date_trunc('hour', NOW()) - $6::interval AS from_ts, NOW() AS to_ts
      ),
      itins AS (
        SELECT i.id, i.airline
        FROM fare_itineraries i
        WHERE i.airline = ANY($1::text[])
          AND i.origin = $2 AND i.destination = $3
          AND i.outbound_date BETWEEN $4 AND $5
          ${tripFilter}
      ),
      -- Money in Real, with the rate frozen at collection (017) — the same ruler
      -- the card's total and the 30-day baseline already use.
      --
      -- It used to read the collected currency and keep only ONE of them (015,
      -- against averaging R$7,627 with £730). That fixed the average and broke the
      -- box: the chart drew the series in GBP while the "Mín./Média 30 dias" beside
      -- it came from getPairSummary, in BRL, and both were labelled with the
      -- series' £ — a Real number wearing a pound sign, and a line an order of
      -- magnitude away from the stats next to it.
      --
      -- In Real there is no currency to elect and no sample to discard. Points stay
      -- in points: PTS is not an exchange currency.
      segs AS (
        SELECT h.id, i.airline, h.amount_cash_brl AS amount_cash, h.amount_pts, h.amount_hyb_pts,
               h.amount_hyb_cash_brl AS amount_hyb_cash, h.observed_from, h.last_seen_at
        FROM fare_price_history h
        JOIN itins i ON i.id = h.itinerary_id
        WHERE h.last_seen_at >= (SELECT from_ts FROM bounds)
      ),
      buckets AS (
        SELECT gs AS bucket_start
        FROM bounds, generate_series(bounds.from_ts, bounds.to_ts, $7::interval) gs
      )
      SELECT
        b.bucket_start,
        s.airline,
        'BRL'                      AS currency,
        MIN(s.amount_cash)         AS min_cash,
        MIN(s.amount_pts)          AS min_pts,
        MIN(s.amount_hyb_pts)      AS min_hyb_pts,
        MIN(s.amount_hyb_cash)     AS min_hyb_cash,
        COUNT(s.id)::int           AS samples
      FROM buckets b
      -- A segment counts for the bucket it OVERLAPS, not the one it started in.
      -- That is what makes a plateau cover every bucket it spanned, and leaves a
      -- collection gap empty instead of drawing a straight line through it.
      LEFT JOIN segs s
        ON  s.observed_from <  b.bucket_start + $7::interval
        AND s.last_seen_at  >= b.bucket_start
      -- GROUPING SETS: o total (airline NULL) e a curva de cada companhia saem da
      -- MESMA varredura. Em duas queries o destaque e as curvas embaixo dele
      -- podem discordar, que é exatamente o que o card não pode fazer.
      GROUP BY GROUPING SETS ((b.bucket_start), (b.bucket_start, s.airline))
      ORDER BY b.bucket_start, s.airline NULLS FIRST
    `, params)

    const toBucket = (r: FareHistoryBucket): FareHistoryBucket => ({
      bucket_start: r.bucket_start,
      min_cash: r.min_cash,
      min_pts: r.min_pts,
      min_hyb_pts: r.min_hyb_pts,
      min_hyb_cash: r.min_hyb_cash,
      samples: r.samples,
    })

    // airline NULL = a linha do agregado geral; as demais são as curvas.
    const geral = rows.filter((r) => r.airline == null)
    const porCia = new Map<string, FareHistoryBucket[]>()
    for (const r of rows) {
      if (r.airline == null) continue
      const lista = porCia.get(r.airline) ?? []
      lista.push(toBucket(r))
      porCia.set(r.airline, lista)
    }

    return {
      currency: rows[0]?.currency ?? null,
      buckets: geral.map(toBucket),
      byAirline: [...porCia.entries()]
        .map(([airline, buckets]) => ({ airline, buckets }))
        .sort((a, b) => a.airline.localeCompare(b.airline)),
    }
  }

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

  async deleteExclusiveToRoutine(routineId: string): Promise<DeleteHistoryResult> {
    const { rows: before } = await this.db.query<{ segments: string }>(
      `SELECT count(h.id) AS segments
         FROM fare_price_history h
         JOIN fare_itineraries i ON i.id = h.itinerary_id
        WHERE ${itineraryBelongsToRoutine('i', '= $1')}
          AND NOT ${itineraryBelongsToRoutine('i', '<> $1')}`,
      [routineId],
    )

    // The segments go with the itinerary (ON DELETE CASCADE): a series without
    // the itinerary that identifies it has nothing to be a series of.
    const { rowCount } = await this.db.query(
      `DELETE FROM fare_itineraries i
        WHERE ${itineraryBelongsToRoutine('i', '= $1')}
          AND NOT ${itineraryBelongsToRoutine('i', '<> $1')}`,
      [routineId],
    )

    const { rows } = await this.db.query<{ shared: string }>(
      `SELECT count(*) AS shared FROM fare_itineraries i
        WHERE ${itineraryBelongsToRoutine('i', '= $1')}`,
      [routineId],
    )

    return {
      itineraries: rowCount ?? 0,
      segments: Number(before[0]?.segments ?? 0),
      shared: Number(rows[0]?.shared ?? 0),
    }
  }
}
