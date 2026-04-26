import { z } from 'zod'

const iata = z.string().length(3).toUpperCase()
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: YYYY-MM-DD')

const routineBaseSchema = z.object({
  name: z.string().min(1).max(100),
  airline: z.string().min(1).max(10),
  origin: iata,
  destination: iata,
  outboundStart: dateStr,
  outboundEnd: dateStr,
  returnStart: dateStr.nullable().optional(),
  returnEnd: dateStr.nullable().optional(),
  passengers: z.number().int().min(1).max(9).default(1),

  targetBrl: z.number().positive().nullable().optional(),
  targetPts: z.number().int().positive().nullable().optional(),
  targetHybPts: z.number().int().positive().nullable().optional(),
  targetHybBrl: z.number().positive().nullable().optional(),
  margin: z.number().min(0).max(1).default(0.1),
  priority: z.enum(['brl', 'pts', 'hyb']).default('brl'),

  notificationMode: z.enum([
    'daily_best_and_alert',
    'alert_only',
    'end_of_period',
  ]),
  notificationFrequency: z.enum(['hourly', 'daily', 'monthly']),
  endOfPeriodTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional(),

  ccEmails: z.array(z.string().email()).max(10).default([]),
  isActive: z.boolean().default(true),
})

export const createRoutineSchema = routineBaseSchema
  .refine(
    (d) =>
      d.targetBrl != null ||
      d.targetPts != null ||
      (d.targetHybPts != null && d.targetHybBrl != null),
    { message: 'Pelo menos um target deve ser informado (targetBrl, targetPts ou targetHybPts+targetHybBrl)' },
  )
  .refine((d) => d.notificationMode !== 'end_of_period' || d.endOfPeriodTime != null, {
    message: 'endOfPeriodTime é obrigatório para o modo end_of_period',
  })

export const updateRoutineSchema = routineBaseSchema.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'Nenhum campo para atualizar' },
)
