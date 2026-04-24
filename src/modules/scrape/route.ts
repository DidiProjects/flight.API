import { FastifyInstance } from 'fastify'
import { IScrapeService } from './interfaces/IScrapeService'
import { scrapeCallbackSchema } from './schema'
import { env } from '../../config/env'
import { UnauthorizedError } from '../../utils/errors'

export function scrapeRoute(scrapeSvc: IScrapeService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.post('/results', async (req, reply) => {
      if (req.headers['x-api-key'] !== env.FLIGHT_API_KEY) {
        throw new UnauthorizedError('API key inválida')
      }

      const data = scrapeCallbackSchema.parse(req.body)

      // Acknowledge immediately; process async
      scrapeSvc.processCallback(data).catch((err) =>
        req.log.error({ err, routineId: data.routineId }, 'scrape callback error'),
      )

      reply.status(200).send({ received: true })
    })
  }
}
