import { buildApp } from './app'
import { env } from './config/env'
import { logger } from './utils/logger'
import { pool } from './db/pool'
import { container } from './container'

async function main(): Promise<void> {
  const app = await buildApp()
  await app.listen({ port: env.PORT, host: env.HOST })

  container.workerGateway.attach(app.server)
  container.realtimePersistence.start()
  container.schedulerSvc.start()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`${signal} — encerrando`)
    // Ordem importa: 1) para o scheduler (não reivindica/despacha mais nada),
    // 2) fecha o WS do worker, 3) drena os requests HTTP em voo (callbacks),
    // 4) pequena janela p/ o processamento async do callback escoar, 5) fecha o DB.
    container.schedulerSvc.stop()
    container.workerGateway.close()
    await app.close()
    await new Promise((r) => setTimeout(r, 500))
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
