import { Pool } from 'pg'
import { ScrapingJobRow } from '../scraping-jobs/interfaces/IScrapingJobRepository'
import { belongsToRoutine, JOB_IS_ELIGIBLE } from '../scraping-jobs/predicates'
import {
  BatchTerminalStatus,
  ClaimedBatch,
  IScrapingBatchRepository,
  ScrapingBatchRow,
} from './interfaces/IScrapingBatchRepository'

/**
 * Lease reset on claim — the same `last_heartbeat_at = NULL` that `claimNextJob`
 * carried, and for the same reason: a row that already ran carries the heartbeat of
 * THAT run, and `reclaimExpiredJobs` reads it as a lease expired ages ago, taking the
 * job back seconds after it was dispatched. Measured 2026-08-23/24; a failing BA route
 * retried for hours without ever reaching 'dead'.
 *
 * With it NULL the reclaim falls to the grace path, which is the window the worker has
 * to send its first heartbeat — and the snapshot already includes queued jobs, so every
 * item of the batch keeps its lease renewed while it waits its turn.
 */
const CLAIM_SET = `
  status = 'running', running_since = NOW(), started_at = NULL,
  last_heartbeat_at = NULL, updated_at = NOW()`

export class ScrapingBatchRepository implements IScrapingBatchRepository {
  constructor(private readonly db: Pool) {}

  async claimBatch(airline: string, limit: number, attempt = 1): Promise<ClaimedBatch | null> {
    return this.claim(limit, attempt, {
      // The head decides the route; `ORDER BY` is the one the single-job claim used, so
      // which job goes first does not change with the batch.
      headSql: `
        SELECT j.id, j.airline, j.origin, j.destination
          FROM scraping_jobs j
         WHERE j.airline = $1
           AND ${JOB_IS_ELIGIBLE('j')}
         ORDER BY j.priority DESC, j.next_run_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      headParams: [airline],
    })
  }

  async claimBatchForRoutine(routineId: string, limit: number): Promise<ClaimedBatch | null> {
    return this.claim(limit, 1, {
      headSql: `
        SELECT j.id, j.airline, j.origin, j.destination
          FROM scraping_jobs j
         WHERE ${belongsToRoutine('j', '= $1')}
           AND ${JOB_IS_ELIGIBLE('j')}
         ORDER BY j.priority DESC, j.next_run_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      headParams: [routineId],
    })
  }

  /**
   * Head job first, then its route mates, then the batch row — all in one transaction.
   *
   * Two steps instead of one because the route is only known after the head is picked,
   * and both steps lock with SKIP LOCKED so two dispatchers never claim the same item.
   * The batch is inserted last so that a rollback never leaves an empty batch holding
   * the route's unique index.
   */
  private async claim(
    limit: number,
    attempt: number,
    head: { headSql: string; headParams: unknown[] },
  ): Promise<ClaimedBatch | null> {
    const client = await this.db.connect()
    try {
      await client.query('BEGIN')

      const { rows: heads } = await client.query<{ id: string; airline: string; origin: string; destination: string }>(
        head.headSql,
        head.headParams,
      )
      const first = heads[0]
      if (!first) {
        await client.query('ROLLBACK')
        return null
      }

      const ids = [first.id]
      if (limit > 1) {
        const { rows: mates } = await client.query<{ id: string }>(
          `SELECT j.id
             FROM scraping_jobs j
            WHERE j.airline = $1 AND j.origin = $2 AND j.destination = $3
              AND j.id <> $4
              AND ${JOB_IS_ELIGIBLE('j')}
            ORDER BY j.priority DESC, j.next_run_at ASC
            LIMIT $5
            FOR UPDATE SKIP LOCKED`,
          [first.airline, first.origin, first.destination, first.id, limit - 1],
        )
        ids.push(...mates.map((m) => m.id))
      }

      const { rows: batchRows } = await client.query<ScrapingBatchRow>(
        `INSERT INTO scraping_batches (airline, origin, destination, item_count, attempt)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [first.airline, first.origin, first.destination, ids.length, attempt],
      )
      const batch = batchRows[0]!

      const { rows: items } = await client.query<ScrapingJobRow>(
        `UPDATE scraping_jobs SET ${CLAIM_SET}, batch_id = $2
          WHERE id = ANY($1::uuid[])
        RETURNING *`,
        [ids, batch.id],
      )

      await client.query('COMMIT')
      // Same order the ids were claimed in: the head leads, then its route mates.
      const byId = new Map(items.map((i) => [i.id, i]))
      return { batch, items: ids.map((id) => byId.get(id)).filter((i): i is ScrapingJobRow => i != null) }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async findById(id: string): Promise<ScrapingBatchRow | null> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `SELECT * FROM scraping_batches WHERE id = $1`, [id],
    )
    return rows[0] ?? null
  }

  async findLiveByRoute(airline: string, origin: string, destination: string): Promise<ScrapingBatchRow | null> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `SELECT * FROM scraping_batches
        WHERE airline = $1 AND origin = $2 AND destination = $3
          AND status IN ('dispatched','running','closing')`,
      [airline, origin, destination],
    )
    return rows[0] ?? null
  }

  /**
   * Matched by ROUTE and airline, not by job: the batch has no `routine_id` and neither
   * has the job. A routine "owns" a batch when it covers that airline and that route.
   */
  async findLiveForRoutine(routineId: string): Promise<ScrapingBatchRow[]> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `SELECT b.* FROM scraping_batches b
        WHERE b.status IN ('dispatched','running','closing')
          AND EXISTS (
            SELECT 1 FROM routines r
            JOIN routine_airlines ra ON ra.routine_id = r.id
            WHERE r.id = $1
              AND ra.airline    = b.airline
              AND r.origin      = b.origin
              AND r.destination = b.destination
          )`,
      [routineId],
    )
    return rows
  }

  async listItems(batchId: string): Promise<ScrapingJobRow[]> {
    const { rows } = await this.db.query<ScrapingJobRow>(
      `SELECT * FROM scraping_jobs WHERE batch_id = $1 ORDER BY flight_date, return_date NULLS FIRST`,
      [batchId],
    )
    return rows
  }

  async markRunning(id: string): Promise<void> {
    await this.db.query(
      `UPDATE scraping_batches SET status = 'running' WHERE id = $1 AND status = 'dispatched'`,
      [id],
    )
  }

  async registerReceived(id: string): Promise<ScrapingBatchRow | null> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `UPDATE scraping_batches SET received_count = received_count + 1
        WHERE id = $1 RETURNING *`,
      [id],
    )
    return rows[0] ?? null
  }

  /**
   * An item left the batch. `item_count` has to come down with it, otherwise
   * `received_count` never reaches it and the batch would only ever close through the
   * time backstop — which is how a cancelled item would hold a whole route hostage.
   */
  async dropItem(id: string): Promise<ScrapingBatchRow | null> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `UPDATE scraping_batches SET item_count = GREATEST(item_count - 1, 0)
        WHERE id = $1 RETURNING *`,
      [id],
    )
    return rows[0] ?? null
  }

  async markClosing(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE scraping_batches SET status = 'closing', close_reason = $2
        WHERE id = $1 AND status IN ('dispatched','running')`,
      [id, reason],
    )
  }

  async close(id: string, status: BatchTerminalStatus, reason: string): Promise<ScrapingBatchRow | null> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `UPDATE scraping_batches
          SET status = $2, close_reason = $3, closed_at = NOW()
        WHERE id = $1 AND status IN ('dispatched','running','closing')
      RETURNING *`,
      [id, status, reason],
    )
    return rows[0] ?? null
  }

  async markSuperseded(id: string, supersededBy: string | null): Promise<void> {
    await this.db.query(
      `UPDATE scraping_batches SET superseded_by = $2 WHERE id = $1`, [id, supersededBy],
    )
  }

  async countLive(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scraping_batches
        WHERE status IN ('dispatched','running','closing')`,
    )
    return Number(rows[0]?.count ?? 0)
  }

  async countLiveByAirline(airline: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scraping_batches
        WHERE airline = $1 AND status IN ('dispatched','running','closing')`,
      [airline],
    )
    return Number(rows[0]?.count ?? 0)
  }

  async findLiveOlderThan(maxRunMin: number): Promise<ScrapingBatchRow[]> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `SELECT * FROM scraping_batches
        WHERE status IN ('dispatched','running','closing')
          AND created_at < NOW() - ($1 || ' minutes')::interval`,
      [maxRunMin],
    )
    return rows
  }

  /**
   * A block pauses the whole airline (`pauseAirlineForBlock`), and that already puts
   * every job back to 'pending' with `request_id = NULL` — including the running ones.
   * If the batch stayed live, those items would keep failing the claim predicate
   * forever: pending, overdue and invisible. Closing the batches is what breaks that
   * deadlock, and it has to happen alongside the pause.
   */
  async closeLiveByAirline(airline: string, reason: string): Promise<ScrapingBatchRow[]> {
    const { rows } = await this.db.query<ScrapingBatchRow>(
      `UPDATE scraping_batches
          SET status = 'aborted', close_reason = $2, closed_at = NOW()
        WHERE airline = $1 AND status IN ('dispatched','running','closing')
      RETURNING *`,
      [airline, reason],
    )
    return rows
  }
}
