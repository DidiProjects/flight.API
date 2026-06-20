import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { IAdminService } from './AdminService'

const requestIdParam = z.object({ requestId: z.string().uuid() })

export function adminRoute(adminSvc: IAdminService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    // Tudo aqui é admin-only.
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requireAdmin)

    // Snapshot de todos os jobs (estado + running_since p/ duração ao vivo no front).
    app.get('/jobs', async (_req, reply) => {
      reply.send({ jobs: await adminSvc.listJobs() })
    })

    // Timeline de eventos de uma execução (replay do histórico detalhado).
    app.get('/jobs/:requestId/events', async (req, reply) => {
      const { requestId } = requestIdParam.parse(req.params)
      reply.send({ events: await adminSvc.getJobEvents(requestId) })
    })

    // Interromper um job. A confirmação real chega depois via SSE (job.upsert).
    app.post('/jobs/:requestId/cancel', async (req, reply) => {
      const { requestId } = requestIdParam.parse(req.params)
      const result = await adminSvc.cancelJob(requestId, req.user.sub)
      reply.send(result)
    })
  }
}
