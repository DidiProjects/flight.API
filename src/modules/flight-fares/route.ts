import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { IFlightFaresService } from './interfaces/IFlightFaresService'

const historyQuerySchema = z.object({
  airline:     z.string().min(1),
  origin:      z.string().length(3).toUpperCase(),
  destination: z.string().length(3).toUpperCase(),
  flight_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

const summaryQuerySchema = z.object({
  airlines:    z.string().min(1).transform((v) =>
    v.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean),
  ),
  origin:      z.string().length(3).toUpperCase(),
  destination: z.string().length(3).toUpperCase(),
  date_from:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  date_to:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

export function flightFaresRoute(flightFaresSvc: IFlightFaresService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requirePasswordChanged)

    app.get('/history', async (req, reply) => {
      const q = historyQuerySchema.parse(req.query)
      reply.send(await flightFaresSvc.getHistory(q.airline, q.origin, q.destination, q.flight_date))
    })

    app.get('/summary', async (req, reply) => {
      const q = summaryQuerySchema.parse(req.query)
      reply.send(await flightFaresSvc.getSummary(q.airlines, q.origin, q.destination, q.date_from, q.date_to))
    })

    app.get('/current', async (req, reply) => {
      const q = summaryQuerySchema.parse(req.query)
      reply.send(await flightFaresSvc.getCurrent(q.airlines, q.origin, q.destination, q.date_from, q.date_to))
    })

    app.get('/by-date', async (req, reply) => {
      const q = summaryQuerySchema.parse(req.query)
      reply.send({ dates: await flightFaresSvc.getByDate(q.airlines, q.origin, q.destination, q.date_from, q.date_to) })
    })
  }
}
