import { FastifyInstance } from 'fastify'
import { IUnsubscribeService } from './interfaces/IUnsubscribeService'

export function unsubscribeRoute(unsubSvc: IUnsubscribeService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.get('/:token', async (req, reply) => {
      const { token } = req.params as { token: string }

      try {
        const result = await unsubSvc.process(token)
        const msg = result.isPrimary
          ? `Rotina <strong>${result.routineName}</strong> desativada.`
          : `Email <strong>${result.email}</strong> removido da rotina <strong>${result.routineName}</strong>.`
        reply.type('text/html').send(buildPage('Desinscrito com sucesso', msg, true))
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro ao processar a solicitação.'
        reply.type('text/html').send(buildPage('Erro', msg, false))
      }
    })
  }
}

function buildPage(title: string, message: string, success: boolean): string {
  const color = success ? '#22c55e' : '#ef4444'
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>flight.API — ${title}</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:white;border-radius:12px;padding:40px;max-width:440px;width:90%;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,.08)}
    h1{color:#1a1a2e;font-size:22px;margin:0 0 12px}
    p{color:#555;line-height:1.6;margin:0}
    .badge{display:inline-block;margin-top:20px;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:bold;color:white;background:${color}}
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="badge">flight.API</div>
  </div>
</body>
</html>`
}
