import { z } from 'zod'

export const createAirlineSchema = z.object({
  code: z.string().min(2).max(10).toUpperCase(),
  name: z.string().min(1).max(100),
})
