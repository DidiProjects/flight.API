import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

export const seriesQuerySchema = z.object({
  airlines: z.string().min(1).transform((v) =>
    v.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean),
  ),
  origin:      z.string().length(3).toUpperCase(),
  destination: z.string().length(3).toUpperCase(),
  date_from:   isoDate,
  date_to:     isoDate,
  // Return window: present = round-trip routine, and the series is of pair TOTALS.
  inbound_from: isoDate.optional(),
  inbound_to:   isoDate.optional(),
  range: z.enum(['day', 'month', '6m']).default('month'),
})

export type SeriesQuery = z.infer<typeof seriesQuerySchema>
