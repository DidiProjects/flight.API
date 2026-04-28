import { FastifyInstance } from 'fastify'
import { IAirlinesService } from './interfaces/IAirlinesService'
import { createAirlineSchema } from './schema'

export function airlinesRoute(airlinesSvc: IAirlinesService) {
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

    app.delete(
      '/:code',
      { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (req, reply) => {
        const { code } = req.params as { code: string }
        await airlinesSvc.remove(code)
        reply.status(204).send()
      },
    )
  }
}
