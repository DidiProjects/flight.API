import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { IFlightFaresRepository } from './interfaces/IFlightFaresRepository'

const historyQuerySchema = z.object({
  airline:     z.string().min(1),
  origin:      z.string().length(3).toUpperCase(),
  destination: z.string().length(3).toUpperCase(),
  flight_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

export function flightFaresRoute(flightFaresRepo: IFlightFaresRepository) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requirePasswordChanged)

    app.get('/history', async (req, reply) => {
      const query = historyQuerySchema.parse(req.query)
      const history = await flightFaresRepo.getPriceHistory(
        query.airline,
        query.origin,
        query.destination,
        query.flight_date,
      )
      reply.send(history)
    })
  }
}
