import { buildApp } from './app'
import { env } from './config/env'
import { pool } from './db/pool'
import { container } from './container'

async function main(): Promise<void> {
  const app = await buildApp()
  await app.listen({ port: env.PORT, host: '0.0.0.0' })

  container.schedulerSvc.start()

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} — encerrando`)
    await app.close()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('Erro fatal na inicialização:', err)
  process.exit(1)
})
