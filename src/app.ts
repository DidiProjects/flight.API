import Fastify, { FastifyInstance, FastifyRequest } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifyJwt from '@fastify/jwt'
import fastifyRateLimit from '@fastify/rate-limit'

import { env } from './config/env'
import { errorHandler, ForbiddenError, UnauthorizedError } from './utils/errors'
import { container } from './container'

import { healthRoute }      from './modules/health/route'
import { authRoute }        from './modules/auth/route'
import { registerRoute }    from './modules/register/route'
import { usersRoute }       from './modules/users/route'
import { airlinesRoute }    from './modules/airlines/route'
import { routinesRoute }    from './modules/routines/route'
import { scrapeRoute }      from './modules/scrape/route'
import { unsubscribeRoute } from './modules/unsubscribe/route'

export interface JWTPayload {
  sub: string
  role: 'admin' | 'user'
  email: string
  mustChangePassword: boolean
}

// Tells @fastify/jwt what shape req.user has after jwtVerify()
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JWTPayload
    user: JWTPayload
  }
}

// Decorators de auth adicionados à instância Fastify
declare module 'fastify' {
  interface FastifyInstance {
    authenticate:           (req: FastifyRequest) => Promise<void>
    requireAdmin:           (req: FastifyRequest) => Promise<void>
    requirePasswordChanged: (req: FastifyRequest) => Promise<void>
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true })

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined)
    try { done(null, JSON.parse(body as string)) }
    catch (e) { done(e as Error, undefined) }
  })

  await app.register(fastifyHelmet, { contentSecurityPolicy: false })
  await app.register(fastifyCors, {
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  await app.register(fastifyRateLimit, { global: true, max: 120, timeWindow: '1 minute', keyGenerator: (req) => req.ip })
  await app.register(fastifyJwt,    { secret: env.JWT_SECRET })

  // ── Auth decorators ────────────────────────────────────────────────────────
  app.decorate('authenticate', async (req: FastifyRequest) => {
    try { await req.jwtVerify() }
    catch { throw new UnauthorizedError('Token inválido ou expirado') }
  })

  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    if (req.user?.role !== 'admin') throw new ForbiddenError('Acesso restrito a administradores')
  })

  app.decorate('requirePasswordChanged', async (req: FastifyRequest) => {
    if (req.user?.mustChangePassword) throw new ForbiddenError('Altere sua senha antes de continuar')
  })

  app.setErrorHandler(errorHandler)

  // ── Routes ────────────────────────────────────────────────────────────────
  await app.register(async (api) => {
    await api.register(healthRoute)
    await api.register(authRoute(container.authSvc),                  { prefix: '/auth' })
    await api.register(registerRoute(container.usersSvc),             { prefix: '/register' })
    await api.register(usersRoute(container.usersSvc),                { prefix: '/users' })
    await api.register(airlinesRoute(container.airlinesRepo),         { prefix: '/airlines' })
    await api.register(routinesRoute(container.routinesSvc, container.schedulerSvc), { prefix: '/routines' })
    await api.register(scrapeRoute(container.scrapeSvc),              { prefix: '/scrape' })
    await api.register(unsubscribeRoute(container.unsubSvc),          { prefix: '/unsubscribe' })
  }, { prefix: '/flight' })

  return app
}
