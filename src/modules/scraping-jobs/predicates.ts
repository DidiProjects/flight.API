/**
 * SQL fragments shared by the job and batch repositories.
 *
 * They live apart from `ScrapingJobRepository` because the batch claim needs the very
 * same eligibility rule: two spellings of "which job may run now" is how a dispatch
 * path silently stops honouring one of them.
 */

// Jobs whose route no longer has an active routine covering this exact date (and, for
// a pair job, this exact return date too).
export const ORPHAN_PREDICATE = `
  NOT EXISTS (
    SELECT 1 FROM routines r
    JOIN routine_airlines ra ON ra.routine_id = r.id
    WHERE r.is_active = true
      AND r.outbound_end >= CURRENT_DATE
      AND ra.airline     = j.airline
      AND r.origin       = j.origin
      AND r.destination  = j.destination
      AND j.flight_date BETWEEN r.outbound_start AND r.outbound_end
      -- Job RT só pertence a uma rotina RT cujo par de janelas o contém; job
      -- one-way (return_date NULL) só pertence a rotina one_way.
      AND (
        (j.return_date IS NULL     AND r.trip_type = 'one_way')
        OR
        (j.return_date IS NOT NULL AND r.trip_type = 'round_trip'
         AND j.return_date BETWEEN r.inbound_start AND r.inbound_end)
      )
  )`

// Whether a row (job or run) belongs to a routine, matching route, date and
// return_date. Mirrors ORPHAN_PREDICATE above, narrowed to one routine.
export const belongsToRoutine = (alias: string, routineIdComparison: string) => `
  EXISTS (
    SELECT 1 FROM routines r
    JOIN routine_airlines ra ON ra.routine_id = r.id
    WHERE r.id ${routineIdComparison}
      AND ra.airline    = ${alias}.airline
      AND r.origin      = ${alias}.origin
      AND r.destination = ${alias}.destination
      AND ${alias}.flight_date BETWEEN r.outbound_start AND r.outbound_end
      AND (
        (${alias}.return_date IS NULL     AND r.trip_type = 'one_way')
        OR
        (${alias}.return_date IS NOT NULL AND r.trip_type = 'round_trip'
         AND ${alias}.return_date BETWEEN r.inbound_start AND r.inbound_end)
      )
  )`

/**
 * The job is not held by a batch the worker still owns.
 *
 * This is "an operation in a batch is always handled as a batch", written as SQL. While
 * a batch is live its items are off the dispatch pool entirely: the failed ones wait for
 * the batch to close and come back together in the retry batch, instead of trickling
 * back one at a time and spending a whole browser session on a single item.
 */
export const notInLiveBatch = (alias: string) => `
  (${alias}.batch_id IS NULL
   OR NOT EXISTS (
     SELECT 1 FROM scraping_batches b
      WHERE b.id = ${alias}.batch_id
        AND b.status IN ('dispatched', 'running', 'closing')
   ))`

/** Everything a job needs to be dispatchable right now. */
export const JOB_IS_ELIGIBLE = (alias: string) => `
  ${alias}.status IN ('pending', 'failed', 'success')
  AND ${alias}.orphaned_at IS NULL
  AND ${alias}.next_run_at <= NOW()
  AND ${alias}.retry_count < ${alias}.max_retries
  AND ${notInLiveBatch(alias)}`
