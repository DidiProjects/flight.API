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
   * Número do voo de IDA em cujo contexto esta volta foi precificada (busca
   * ida-e-volta). Só vem nas voltas; ausente na ida e no one-way. É o vínculo
   * 1-para-N: sem ele a avaliação soma mínimos de pernas que a companhia nunca
   * ofereceu juntas.
   */
  pairedOutboundFlight: z.string().max(20).nullable().optional(),
  /**
   * Só na IDA: as voltas desta ida existem, mas uma limitação conhecida impede
   * vê-las (em pontos a Azul exige login do TudoAzul). Volta indefinida — o par
   * é exibido sem total e não alerta. Volta que sumiu sem motivo não vem
   * marcada e segue tratada como dado corrompido.
   */
  inboundUnavailable: z.boolean().optional().default(false),
})

export type FlightOfferInput = z.infer<typeof flightOfferSchema>

/**
 * Como a busca terminou, na palavra de quem esteve na tela.
 *
 * Antes o estado era inferido aqui por regex sobre a mensagem de erro — e a
 * mensagem era o palpite que o próprio scraper escrevia ("likely bot/IP
 * block"), o que fez a LATAM ser pausada por uma hora, três vezes em
 * 2026-08-20, por uma página de erro do site dela.
 *
 * Opcional: scraper em versão anterior, ou falha sem tela para classificar
 * (watchdog), continuam chegando sem ele.
 */
const outcomeSchema = z.object({
  state: z.enum(['OFFERS', 'EMPTY', 'BLOCKED', 'LOGIN_REQUIRED', 'SITE_ERROR', 'LAYOUT_CHANGED']),
  reason: z.string().max(300).optional(),
  /** O trecho de DOM (ou a URL) que sustenta o estado. Truncado: é prova, não arquivo. */
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
