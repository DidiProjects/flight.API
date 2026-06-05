import { FastifyInstance } from 'fastify'
import { IAirportsService } from './interfaces/IAirportsService'
import { coverageBodySchema, listQuerySchema } from './schema'
import { env } from '../../config/env'
import { UnauthorizedError } from '../../utils/errors'

/**
 * Routes mounted under /scrape:
 *   POST /flight/scrape/coverage  (x-api-key)
 */
export function airportsScrapeRoute(airportsSvc: IAirportsService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.post('/coverage', async (req, reply) => {
      if (req.headers['x-api-key'] !== env.FLIGHT_API_KEY) {
        throw new UnauthorizedError('API key inválida')
      }

      const { airline, airports } = coverageBodySchema.parse(req.body)
      const result = await airportsSvc.upsertCoverage(airline, airports)
      reply.status(200).send(result)
    })
  }
}

/**
 * Routes mounted under /airports:
 *   GET /flight/airports?airline=...  (Bearer JWT)
 */
export function airportsRoute(airportsSvc: IAirportsService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.get(
      '/',
      { preHandler: [app.authenticate, app.requirePasswordChanged] },
      async (req, reply) => {
        const { airline } = listQuerySchema.parse(req.query)
        const results = await airportsSvc.listByAirline(airline)
        reply.send(results)
      },
    )
  }
}
