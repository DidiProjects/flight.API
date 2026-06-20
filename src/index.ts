import { buildApp } from './app'
import { env } from './config/env'
import { logger } from './utils/logger'
import { pool } from './db/pool'
import { container } from './container'
import { attachWorkerGateway, closeWorkerGateway } from './realtime/workerGateway'
import { startRealtimePersistence } from './realtime/realtimePersistence'

async function main(): Promise<void> {
  const app = await buildApp()
  await app.listen({ port: env.PORT, host: env.HOST })

  // Canal WS hub ← workers (telemetria + cancelamento) sobre o mesmo http server.
  attachWorkerGateway(app.server)
  // Persistência da telemetria (timeline + confirmação de cancelamento).
  startRealtimePersistence({
    analysisRunsRepo: container.analysisRunsRepo,
    scrapingJobRepo: container.scrapingJobRepo,
  })

  container.schedulerSvc.start()

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} — encerrando`)
    closeWorkerGateway()
    await app.close()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'Erro fatal na inicialização')
  process.exit(1)
})
