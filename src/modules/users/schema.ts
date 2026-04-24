import { z } from 'zod'

export const createUserSchema = z.object({
  email: z.string().email(),
})

export const approveUserSchema = z.object({
  role: z.enum(['admin', 'user']),
})

export const updateUserSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
})

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
})
