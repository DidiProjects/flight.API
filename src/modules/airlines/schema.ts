import { z } from 'zod'

export const createAirlineSchema = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(1).max(100),
})

export const updateFareTypesSchema = z.object({
  hasCash: z.boolean(),
  hasPts: z.boolean(),
  hasHyb: z.boolean(),
})
