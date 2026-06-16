import { z } from 'zod'

const iata = z.string().length(3).toUpperCase()
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: YYYY-MM-DD')

const nullableStr = (schema: z.ZodString) =>
  z.union([schema, z.literal(''), z.null()])
    .transform((v): string | null => (v === '' ? null : v))
    .optional()

const routineBaseSchema = z.object({
  name: z.string().min(1).max(100),
  airlines: z.array(z.string().min(1).max(20)).min(1),
  origin: iata,
  destination: iata,
  outboundStart: dateStr,
  outboundEnd: dateStr,
  returnStart: nullableStr(dateStr),
  returnEnd: nullableStr(dateStr),
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
    (d) => daysBetween(d.outboundStart, d.outboundEnd) <= MAX_DATE_RANGE_DAYS,
    {
      message: 'O range de datas de ida não pode exceder 30 dias',
      path: ['outboundEnd'],
    },
  )
  .refine(
    (d) => {
      if (d.returnStart == null || d.returnEnd == null) return true
      return daysBetween(d.returnStart, d.returnEnd) <= MAX_DATE_RANGE_DAYS
    },
    {
      message: 'O range de datas de volta não pode exceder 30 dias',
      path: ['returnEnd'],
    },
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
      return daysBetween(d.outboundStart, d.outboundEnd) <= MAX_DATE_RANGE_DAYS
    },
    {
      message: 'O range de datas de ida não pode exceder 30 dias',
      path: ['outboundEnd'],
    },
  )
  .refine(
    (d) => {
      if (d.returnStart == null || d.returnEnd == null) return true
      return daysBetween(d.returnStart, d.returnEnd) <= MAX_DATE_RANGE_DAYS
    },
    {
      message: 'O range de datas de volta não pode exceder 30 dias',
      path: ['returnEnd'],
    },
  )
