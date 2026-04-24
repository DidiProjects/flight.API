import { FastifyInstance } from 'fastify'
import { IAirlinesRepository } from './interfaces/IAirlinesRepository'

export function airlinesRoute(airlinesRepo: IAirlinesRepository) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.get(
      '/',
      { preHandler: [app.authenticate, app.requirePasswordChanged] },
      async (_req, reply) => {
        reply.send(await airlinesRepo.findActive())
      },
    )
  }
}
