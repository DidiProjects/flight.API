import pino from 'pino'
import { env } from '../config/env'

const targets: pino.TransportTargetOptions[] = []

const hasPinoPretty = (() => { try { require.resolve('pino-pretty'); return true } catch { return false } })()

if (env.NODE_ENV === 'development' && hasPinoPretty) {
  targets.push({
    target: 'pino-pretty',
    level: env.LOG_LEVEL,
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
  })
} else {
  targets.push({
    target: 'pino/file',
    level: env.LOG_LEVEL,
    options: { destination: 1 },
  })
}

if (env.GRAFANA_LOKI_URL) {
  targets.push({
    target: 'pino-loki',
    level: env.LOG_LEVEL,
    options: {
      host: env.GRAFANA_LOKI_URL,
      basicAuth:
        env.GRAFANA_LOKI_USER && env.GRAFANA_LOKI_TOKEN
          ? { username: env.GRAFANA_LOKI_USER, password: env.GRAFANA_LOKI_TOKEN }
          : undefined,
      labels: { app: 'flight-api', env: env.NODE_ENV },
      silenceErrors: true,
    },
  })
}

export const logger = pino({ level: env.LOG_LEVEL }, pino.transport({ targets }))
