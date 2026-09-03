import { z } from 'zod'

const flightOfferSchema = z.object({
  airline: z.string().min(1),
  flightNumber: z.string(),
  date: z.string(),
  isReturn: z.boolean().default(false),
  origin: z.string().min(1).transform((v) => v.trim().slice(0, 3).toUpperCase()),
  departureTime: z.string(),
  destination: z.string().min(1).transform((v) => v.trim().slice(0, 3).toUpperCase()),
  arrivalTime: z.string(),
  durationMin: z.number().int().positive(),
  stops: z.number().int().min(0).default(0),
  currency: z.string().length(3).toUpperCase().optional(),
  fareCash: z.number().positive().nullable().optional(),
  farePts: z.number().int().positive().nullable().optional(),
  fareHybPts: z.number().int().positive().nullable().optional(),
  fareHybCash: z.number().positive().nullable().optional(),
  /**
   * OUTBOUND flight number in whose context this return was priced (round-trip
   * search). Only on returns; absent on the outbound and on one-way. It is the
   * 1-to-N link: without it, evaluation sums leg minimums the airline never
   * offered together.
   */
  pairedOutboundFlight: z.string().max(20).nullable().optional(),
  /**
   * Outbound only: the returns of this outbound exist, but a known limitation hides
   * them (on points Azul requires a TudoAzul login). Return undefined — the pair is
   * displayed without a total and does not alert. A return that vanished for no
   * reason is not marked and stays treated as corrupted data.
   */
  inboundUnavailable: z.boolean().optional().default(false),
})

export type FlightOfferInput = z.infer<typeof flightOfferSchema>

/**
 * How the search ended, in the words of whoever was on the screen.
 *
 * The state used to be inferred here by regex over the error message — and the
 * message was the guess the scraper itself wrote ("likely bot/IP block"), which got
 * LATAM paused for an hour, three times on 2026-08-20, over an error page of its
 * own site.
 *
 * Optional: an older scraper, or a failure with no screen to classify (watchdog),
 * still arrive without it.
 */
const outcomeSchema = z.object({
  state: z.enum(['OFFERS', 'EMPTY', 'BLOCKED', 'LOGIN_REQUIRED', 'SITE_ERROR', 'LAYOUT_CHANGED']),
  reason: z.string().max(300).optional(),
  /** The DOM excerpt (or the URL) backing the state. Truncated: it is proof, not a file. */
  evidence: z.string().max(2000).optional(),
})

export type ScrapeOutcome = z.infer<typeof outcomeSchema>

export const scrapeCallbackSchema = z.object({
  requestId: z.string().uuid(),
  routineId: z.string().uuid().optional(),
  airline: z.string().min(1),
  origin: z.string().length(3),
  destination: z.string().length(3),
  flights: z.array(flightOfferSchema).default([]),
  scrapedAt: z.string(),
  error: z.string().nullable().optional(),
  outcome: outcomeSchema.nullable().optional(),
})

export type ScrapeCallback = z.infer<typeof scrapeCallbackSchema>

/**
 * How each item of a batch ended, in the worker's own words.
 *
 * `not_attempted` is the reason this message exists: it is the only thing the API
 * cannot deduce. Without it, a block on item 3 of 8 would burn `retry_count` on five
 * items that never ran, and three nights like that would take the whole route to
 * 'dead'.
 */
const batchItemResultSchema = z.object({
  requestId: z.string().uuid(),
  state: z.enum(['delivered', 'failed', 'not_attempted', 'cancelled']),
  /**
   * Truncado, nunca recusado.
   *
   * Um `max()` aqui rejeita o fechamento inteiro por causa do tamanho de uma mensagem
   * de erro — e fechamento recusado deixa o lote vivo para sempre, o que tranca TODOS
   * os itens da rota fora do claim. Aconteceu na primeira corrida real, 2026-09-03: o
   * banner de instalação do Playwright passou de 500 caracteres e o lote ficou preso
   * em `running`, com o worker reenviando o mesmo 422 em laço.
   *
   * A mensagem é diagnóstico; o fechamento é integridade. Cortar a primeira para
   * salvar a segunda é a troca certa.
   */
  error: z.string().transform((v) => v.slice(0, 500)).optional(),
  why: z.string().transform((v) => v.slice(0, 120)).optional(),
})

export const batchCallbackSchema = z.object({
  batchId: z.string().uuid(),
  airline: z.string().min(1),
  closedAt: z.string(),
  /**
   * Why the session ended. Only `blocked` aborts a batch — a LATAM `SITE_ERROR` must
   * not: calling the airline's own error page a block paused LATAM for an hour, three
   * times on 2026-08-20, and with batches it would take every remaining item with it.
   */
  reason: z.enum(['completed', 'blocked', 'watchdog', 'superseded', 'cancelled']),
  items: z.array(batchItemResultSchema).default([]),
})

export type BatchCallback = z.infer<typeof batchCallbackSchema>
export type BatchItemResult = z.infer<typeof batchItemResultSchema>
