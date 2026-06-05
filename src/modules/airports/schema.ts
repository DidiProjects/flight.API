import { z } from 'zod'

export const airportInputSchema = z.object({
  code:        z.string().min(2).max(10).toUpperCase(),
  name:        z.string().min(1).max(200).optional(),
  timezone:    z.string().min(1).max(100).optional(),
  countryCode: z.string().min(2).max(10).optional(),
  countryName: z.string().min(1).max(100).optional(),
  city:        z.string().min(1).max(100).optional(),
  region:      z.string().min(1).max(100).optional(),
  currency:    z.string().length(3).toUpperCase().optional(),
})

export const coverageBodySchema = z.object({
  airline:  z.string().min(1).max(20),
  airports: z.array(airportInputSchema).min(1),
})

export const coverageAdminBodySchema = z.object({
  airports: z.array(airportInputSchema).min(1),
})

export const listQuerySchema = z.object({
  airline: z.string().min(1).max(20),
})

export type AirportInputDTO = z.infer<typeof airportInputSchema>
export type CoverageBody    = z.infer<typeof coverageBodySchema>
export type ListQuery       = z.infer<typeof listQuerySchema>
