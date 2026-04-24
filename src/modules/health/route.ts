import { FastifyInstance } from 'fastify'
import { pool } from '../../db/pool'

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1')
      reply.send({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() })
    } catch {
      reply.status(503).send({ status: 'error', db: 'disconnected' })
    }
  })
}
