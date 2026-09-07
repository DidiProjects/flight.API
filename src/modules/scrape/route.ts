import { FastifyInstance } from 'fastify'
import { IScrapeService } from './interfaces/IScrapeService'
import { batchCallbackSchema, scrapeCallbackSchema } from './schema'
import { env } from '../../config/env'
import { UnauthorizedError } from '../../utils/errors'

export function scrapeRoute(scrapeSvc: IScrapeService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.post('/results', async (req, reply) => {
      if (req.headers['x-api-key'] !== env.FLIGHT_API_KEY) {
        throw new UnauthorizedError('API key inválida')
      }

      let data
      try {
        data = scrapeCallbackSchema.parse(req.body)
      } catch (err) {
        req.log.warn({ err, body: req.body }, 'scrape callback validation failed')
        throw err
      }

      // Acknowledge immediately; process async
      scrapeSvc.processCallback(data).catch((err) =>
        req.log.error({ err, routineId: data.routineId }, 'scrape callback error'),
      )

      reply.status(200).send({ received: true })
    })

    // Fechamento do lote. Vai pelo mesmo canal HTTP dos callbacks de item, e depois
    // deles, de proposito: canal separado nao garante ordem, e um fechamento que
    // passasse na frente do ultimo callback fecharia o lote com item ainda no ar.
    app.post('/batch-results', async (req, reply) => {
      if (req.headers['x-api-key'] !== env.FLIGHT_API_KEY) {
        throw new UnauthorizedError('API key inválida')
      }

      let data
      try {
        data = batchCallbackSchema.parse(req.body)
      } catch (err) {
        req.log.warn({ err, body: req.body }, 'batch callback validation failed')
        throw err
      }

      scrapeSvc.processBatchCallback(data).catch((err) =>
        req.log.error({ err, batchId: data.batchId }, 'batch callback error'),
      )

      reply.status(200).send({ received: true })
    })
  }
}
