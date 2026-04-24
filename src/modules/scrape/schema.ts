import { z } from 'zod'

const flightOfferSchema = z.object({
  flightNumber: z.string(),
  date: z.string(),
  isReturn: z.boolean().default(false),
  origin: z.string().length(3),
  departureTime: z.string(),
  destination: z.string().length(3),
  arrivalTime: z.string(),
  durationMin: z.number().int().positive(),
  stops: z.number().int().min(0).default(0),
  fareBrl: z.number().positive().nullable().optional(),
  farePts: z.number().int().positive().nullable().optional(),
  fareHybPts: z.number().int().positive().nullable().optional(),
  fareHybBrl: z.number().positive().nullable().optional(),
})

export type FlightOfferInput = z.infer<typeof flightOfferSchema>

export const scrapeCallbackSchema = z.object({
  requestId: z.string().uuid(),
  routineId: z.string().uuid(),
  origin: z.string().length(3),
  destination: z.string().length(3),
  flights: z.array(flightOfferSchema).default([]),
  scrapedAt: z.string(),
  error: z.string().nullable().optional(),
})

export type ScrapeCallback = z.infer<typeof scrapeCallbackSchema>
