import { FastifyInstance } from 'fastify'
import { IFareHistoryService } from './interfaces/IFareHistoryService'
import { seriesQuerySchema } from './schema'

export function fareHistoryRoute(svc: IFareHistoryService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requirePasswordChanged)

    app.get('/series', async (req, reply) => {
      const q = seriesQuerySchema.parse(req.query)
      const inbound = q.inbound_from && q.inbound_to
        ? { from: q.inbound_from, to: q.inbound_to }
        : undefined

      const series = await svc.getSeries({
        airlines:    q.airlines,
        origin:      q.origin,
        destination: q.destination,
        dateFrom:    q.date_from,
        dateTo:      q.date_to,
        inbound,
      }, q.range)

      reply.send({ range: q.range, ...series })
    })
  }
}
