import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { IAdminService } from './AdminService'

const requestIdParam = z.object({ requestId: z.string().uuid() })
const jobIdParam = z.object({ jobId: z.string().uuid() })
const routineIdParam = z.object({ routineId: z.string().uuid() })

export function adminRoute(adminSvc: IAdminService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    // Tudo aqui é admin-only.
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requireAdmin)

    // Snapshot de todos os jobs (estado + running_since p/ duração ao vivo no front).
    app.get('/jobs', async (_req, reply) => {
      reply.send({ jobs: await adminSvc.listJobs() })
    })

    app.get('/jobs/:requestId/events', async (req, reply) => {
      const { requestId } = requestIdParam.parse(req.params)
      reply.send({ events: await adminSvc.getJobEvents(requestId) })
    })

    app.get('/jobs/:jobId/timeline', async (req, reply) => {
      const { jobId } = jobIdParam.parse(req.params)
      reply.send({ events: await adminSvc.getJobTimeline(jobId) })
    })

    // Interromper um job. A confirmação real chega depois via SSE (job.upsert).
    app.post('/jobs/:requestId/cancel', async (req, reply) => {
      const { requestId } = requestIdParam.parse(req.params)
      const result = await adminSvc.cancelJob(requestId, req.user.sub)
      reply.send(result)
    })

    // Reenvia o último e-mail da rotina — alerta de target ou resumo do dia, o
    // que tiver saído por último. O conteúdo é remontado com os dados de agora.
    app.post('/routines/:routineId/resend-last-notification', async (req, reply) => {
      const { routineId } = routineIdParam.parse(req.params)
      reply.send(await adminSvc.resendLastNotification(routineId))
    })

    // Zera o histórico de análises da rotina. Preserva o que outra rotina também
    // enxerga e o que está em execução — a resposta diz o que ficou.
    app.post('/routines/:routineId/reset-analyses', async (req, reply) => {
      const { routineId } = routineIdParam.parse(req.params)
      reply.send(await adminSvc.resetRoutineAnalyses(routineId))
    })
  }
}
