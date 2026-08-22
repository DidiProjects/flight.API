import { z } from 'zod'
import { MAX_ROUNDTRIP_SPAN_MONTHS, roundTripPricingError, windowsCanFormValidPair } from '../../utils/roundtrip'

const iata = z.string().length(3).toUpperCase()
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: YYYY-MM-DD')

const routineBaseSchema = z.object({
  name: z.string().min(1).max(100),
  airlines: z.array(z.string().min(1).max(20)).min(1),
  origin: iata,
  destination: iata,
  outboundStart: dateStr,
  outboundEnd: dateStr,
  tripType: z.enum(['one_way', 'round_trip']).default('one_way'),
  inboundStart: dateStr.nullable().optional(),
  inboundEnd: dateStr.nullable().optional(),
  passengers: z.number().int().min(1).max(9).default(1),

  targetCash: z.number().positive().nullable().optional(),
  targetPts: z.number().int().positive().nullable().optional(),
  targetHybPts: z.number().int().positive().nullable().optional(),
  targetHybCash: z.number().positive().nullable().optional(),
  margin: z.number().min(0).max(1).default(0.1),
  priority: z.enum(['cash', 'pts', 'hyb']).default('cash'),

  notificationModes: z.array(z.enum(['target', 'scheduled'])).min(1),
  notificationFrequency: z.enum(['hourly', 'daily', 'monthly']).optional(),
  scheduledTime: z.union([
    z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    z.literal(''),
    z.null(),
  ]).transform((v): string | null => (v == null || v === '' ? null : v.slice(0, 5))).optional(),

  ccEmails: z.array(z.string().email()).max(10).default([]),
  isActive: z.boolean().default(true),
})

const MAX_DATE_RANGE_DAYS = 30

/**
 * Window ceiling on round-trip, much lower than the one-way one.
 *
 * RT collection goes by PAIR of dates: the number of searches is the PRODUCT of the
 * two windows, not the sum. With the 30-day ceiling applying to both, one routine
 * would ask for 900 searches per cycle per airline — at ~2.5 min each, over 37
 * hours of scraping to close a single cycle. Five days caps the pair at 25.
 */
const MAX_ROUNDTRIP_RANGE_DAYS = 5

/** One-way keeps the 30 days; round-trip drops to 5. */
function maxRangeFor(tripType: string | undefined): number {
  return tripType === 'round_trip' ? MAX_ROUNDTRIP_RANGE_DAYS : MAX_DATE_RANGE_DAYS
}

/**
 * The same ceiling, for the PATCH — where `tripType` may not come in the body.
 *
 * Return dates in the payload give round-trip away even without the field: whoever
 * edits the return window is editing a routine that has one.
 */
function maxRangeForPatch(d: {
  tripType?: string
  inboundStart?: string | null
  inboundEnd?: string | null
}): number {
  const ehRoundTrip = d.tripType === 'round_trip' || d.inboundStart != null || d.inboundEnd != null
  return ehRoundTrip ? MAX_ROUNDTRIP_RANGE_DAYS : MAX_DATE_RANGE_DAYS
}

function daysBetween(start: string, end: string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24)
}

export const createRoutineSchema = routineBaseSchema
  .transform((d) => {
    // Default scheduledTime to '20:00' when 'scheduled' is in notificationModes and no value provided
    if (d.notificationModes.includes('scheduled') && !d.scheduledTime) {
      return { ...d, scheduledTime: '20:00' }
    }
    return d
  })
  .refine(
    (d) =>
      !d.notificationModes.includes('target') ||
      d.targetCash != null ||
      d.targetPts != null ||
      (d.targetHybPts != null && d.targetHybCash != null),
    {
      message: 'Quando o modo "target" está ativo, pelo menos um target deve ser informado (targetCash, targetPts ou targetHybPts+targetHybCash)',
    },
  )
  .refine(
    (d) => !d.notificationModes.includes('scheduled') || d.scheduledTime != null,
    {
      message: 'scheduledTime é obrigatório para o modo scheduled',
    },
  )
  .refine(
    (d) => !d.notificationModes.includes('target') || d.notificationFrequency != null,
    {
      message: 'notificationFrequency é obrigatório para o modo target',
      path: ['notificationFrequency'],
    },
  )
  .refine(
    (d) => daysBetween(d.outboundStart, d.outboundEnd) <= maxRangeFor(d.tripType),
    (d) => ({
      message: `O range de datas de ida não pode exceder ${maxRangeFor(d.tripType)} dias`,
      path: ['outboundEnd'],
    }),
  )
  .refine(
    (d) => d.tripType !== 'round_trip' || (d.inboundStart != null && d.inboundEnd != null),
    {
      message: 'inboundStart e inboundEnd são obrigatórios quando tripType é round_trip',
      path: ['inboundStart'],
    },
  )
  .refine(
    (d) => d.tripType !== 'one_way' || (d.inboundStart == null && d.inboundEnd == null),
    {
      message: 'inboundStart e inboundEnd só são aceitos quando tripType é round_trip',
      path: ['inboundStart'],
    },
  )
  .refine(
    (d) => d.inboundStart == null || d.inboundEnd == null ||
      daysBetween(d.inboundStart, d.inboundEnd) <= maxRangeFor(d.tripType),
    (d) => ({
      message: `O range de datas de volta não pode exceder ${maxRangeFor(d.tripType)} dias`,
      path: ['inboundEnd'],
    }),
  )
  .refine(
    (d) => d.inboundStart == null || d.inboundStart >= d.outboundStart,
    {
      message: 'A volta não pode começar antes da ida',
      path: ['inboundStart'],
    },
  )
  .refine(
    (d) => d.inboundStart == null || d.inboundEnd == null ||
      windowsCanFormValidPair(d.outboundStart, d.outboundEnd, d.inboundStart, d.inboundEnd),
    {
      message: `Nenhuma combinação de ida e volta cabe no limite de ${MAX_ROUNDTRIP_SPAN_MONTHS} meses`,
      path: ['inboundEnd'],
    },
  )
  .refine(
    (d) => d.tripType !== 'round_trip' || roundTripPricingError(d) == null,
    (d) => ({ message: roundTripPricingError(d) ?? '', path: ['priority'] }),
  )

export const updateRoutineSchema = routineBaseSchema
  .partial()
  .transform((d) => {
    // Default scheduledTime to '20:00' when 'scheduled' is in notificationModes and no value provided
    if (d.notificationModes && d.notificationModes.includes('scheduled') && !d.scheduledTime) {
      return { ...d, scheduledTime: '20:00' }
    }
    return d
  })
  .refine(
    (d) => Object.keys(d).length > 0,
    { message: 'Nenhum campo para atualizar' },
  )
  .refine(
    (d) => {
      if (d.outboundStart == null || d.outboundEnd == null) return true
      return daysBetween(d.outboundStart, d.outboundEnd) <= maxRangeForPatch(d)
    },
    (d) => ({
      message: `O range de datas de ida não pode exceder ${maxRangeForPatch(d)} dias`,
      path: ['outboundEnd'],
    }),
  )
  // The return window was not validated on PATCH — only on creation. Without this
  // the round-trip ceiling could be worked around by editing the routine afterwards.
  .refine(
    (d) => {
      if (d.inboundStart == null || d.inboundEnd == null) return true
      return daysBetween(d.inboundStart, d.inboundEnd) <= maxRangeForPatch(d)
    },
    (d) => ({
      message: `O range de datas de volta não pode exceder ${maxRangeForPatch(d)} dias`,
      path: ['inboundEnd'],
    }),
  )
