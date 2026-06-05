import { FastifyInstance } from 'fastify'
import { IAirlinesService } from './interfaces/IAirlinesService'
import { IAirportsService } from '../airports/interfaces/IAirportsService'
import { createAirlineSchema, updateFareTypesSchema } from './schema'
import { coverageAdminBodySchema } from '../airports/schema'
import { env } from '../../config/env'

export function airlinesRoute(airlinesSvc: IAirlinesService, airportsSvc: IAirportsService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.get(
      '/',
      { preHandler: [app.authenticate, app.requirePasswordChanged] },
      async (_req, reply) => {
        reply.send(await airlinesSvc.listActive())
      },
    )

    app.get(
      '/admin',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (_req, reply) => {
        reply.send(await airlinesSvc.listAll())
      },
    )

    app.post(
      '/',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code, name, currency } = createAirlineSchema.parse(req.body)
        reply.status(201).send(await airlinesSvc.create(code, name, currency))
      },
    )

    app.patch(
      '/:code/activate',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code } = req.params as { code: string }
        reply.send(await airlinesSvc.activate(code))
      },
    )

    app.patch(
      '/:code/deactivate',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code } = req.params as { code: string }
        reply.send(await airlinesSvc.deactivate(code))
      },
    )

    app.patch(
      '/:code/fare-types',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code } = req.params as { code: string }
        const { hasCash, hasPts, hasHyb } = updateFareTypesSchema.parse(req.body)
        reply.send(await airlinesSvc.updateFareTypes(code, hasCash, hasPts, hasHyb))
      },
    )

    app.delete(
      '/:code',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code } = req.params as { code: string }
        await airlinesSvc.remove(code)
        reply.status(204).send()
      },
    )

    app.put(
      '/admin/:code/coverage',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code } = req.params as { code: string }
        const { airports } = coverageAdminBodySchema.parse(req.body)
        const result = await airportsSvc.upsertCoverage(code, airports)
        reply.send(result)
      },
    )

    app.post(
      '/admin/:code/dispatch-coverage',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code } = req.params as { code: string }
        const res = await fetch(`${env.SCRAPING_API_URL}/coverage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': env.SCRAPING_API_KEY },
          body:    JSON.stringify({ airline: code }),
          signal:  AbortSignal.timeout(10_000),
        })
        if (res.status === 422) {
          const body = await res.json().catch(() => ({ error: 'Airline not supported' })) as { error: string }
          return reply.status(422).send({ error: body.error })
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`scraping.API ${res.status}: ${text}`)
        }
        return reply.status(202).send({ airline: code, queued: true })
      },
    )
  }
}
