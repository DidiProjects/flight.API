import { FastifyInstance } from 'fastify'
import { IAirlinesService } from './interfaces/IAirlinesService'
import { IAirportsService } from '../airports/interfaces/IAirportsService'
import { createAirlineSchema, routeQuerySchema, updateFareTypesSchema } from './schema'
import { coverageAdminBodySchema } from '../airports/schema'

export function airlinesRoute(airlinesSvc: IAirlinesService, airportsSvc: IAirportsService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.get(
      '/',
      { preHandler: [app.authenticate, app.requirePasswordChanged] },
      async (_req, reply) => {
        reply.send(await airlinesSvc.listActive())
      },
    )

    // Quais companhias fazem sentido para um trajeto. Devolve TODAS as ativas,
    // cada uma com `recommended` e o motivo: o mapa de mercado decide o padrão
    // do formulário, nunca o teto do que o usuário pode escolher.
    app.get(
      '/recommended',
      { preHandler: [app.authenticate, app.requirePasswordChanged] },
      async (req, reply) => {
        const { origin, destination } = routeQuerySchema.parse(req.query)
        reply.send(await airlinesSvc.listForRoute(origin, destination))
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
        const { code, name } = createAirlineSchema.parse(req.body)
        reply.status(201).send(await airlinesSvc.create(code, name))
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
  }
}
