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
 * Teto de janela em ida-e-volta, bem menor que o de só-ida.
 *
 * A coleta RT é por PAR de datas: o número de buscas é o PRODUTO das duas
 * janelas, não a soma. Com o teto de 30 dias valendo para as duas, uma rotina
 * pediria 900 buscas por ciclo e por companhia — a ~2,5 min cada, mais de 37
 * horas de scraping para fechar um único ciclo. Cinco dias limita o par a 25.
 */
const MAX_ROUNDTRIP_RANGE_DAYS = 5

/** Só-ida mantém os 30 dias; ida-e-volta cai para 5. */
function maxRangeFor(tripType: string | undefined): number {
  return tripType === 'round_trip' ? MAX_ROUNDTRIP_RANGE_DAYS : MAX_DATE_RANGE_DAYS
}

/**
 * O mesmo teto, para o PATCH — onde `tripType` pode não vir no corpo.
 *
 * Datas de volta no payload denunciam ida-e-volta mesmo sem o campo: quem
 * edita a janela de volta está editando uma rotina que a tem.
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
  // A janela de volta não era validada no PATCH — só na criação. Sem isto o teto
  // de ida-e-volta seria contornável editando a rotina depois de criada.
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
