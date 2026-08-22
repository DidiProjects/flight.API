import { pool } from './db/pool'
import { env } from './config/env'

// Repositories
import { AuthRepository }             from './modules/auth/AuthRepository'
import { RefreshTokenRepository }     from './modules/auth/RefreshTokenRepository'
import { UsersRepository }            from './modules/users/UsersRepository'
import { AirlinesRepository }         from './modules/airlines/AirlinesRepository'
import { RoutinesRepository }         from './modules/routines/RoutinesRepository'
import { UnsubscribeTokensRepository } from './modules/unsubscribe/UnsubscribeTokensRepository'
import { NotificationLogRepository }  from './services/notifications/NotificationLogRepository'
import { AirportsRepository }         from './modules/airports/AirportsRepository'
import { ScrapingJobRepository }      from './modules/scraping-jobs/ScrapingJobRepository'
import { FlightFaresRepository }      from './modules/flight-fares/FlightFaresRepository'
import { AnalysisRunsRepository }     from './modules/analysis-runs/AnalysisRunsRepository'
import { TargetAlertStateRepository } from './modules/target-alert-state/TargetAlertStateRepository'

// Services
import { HttpScraperClient }    from './services/scraper-client/HttpScraperClient'
import { FlightFaresService }   from './modules/flight-fares/FlightFaresService'
import { EmailService }         from './services/email/EmailService'
import { NotificationsService } from './services/notifications/NotificationsService'
import { AuthService }          from './modules/auth/AuthService'
import { UsersService }         from './modules/users/UsersService'
import { AirlinesService }      from './modules/airlines/AirlinesService'
import { RoutinesService }      from './modules/routines/RoutinesService'
import { ScrapeService }        from './modules/scrape/ScrapeService'
import { UnsubscribeService }   from './modules/unsubscribe/UnsubscribeService'
import { SchedulerService }     from './services/scheduler/SchedulerService'
import { AirportsService }      from './modules/airports/AirportsService'
import { EvaluationService }    from './services/evaluation/EvaluationService'
import { FxRateService }        from './services/fx/FxRateService'
import { ExchangeRateHttpClient } from './services/fx/ExchangeRateHttpClient'
import { FrankfurterProvider }  from './services/fx/providers/FrankfurterProvider'
import { CurrencyApiProvider }  from './services/fx/providers/CurrencyApiProvider'
import { AnalysisRunsService }  from './modules/analysis-runs/AnalysisRunsService'
import { AdminService }         from './modules/admin/AdminService'

// Realtime (hub ← workers WS, SSE → admin)
import { HubBus }               from './realtime/hubBus'
import { WorkerGateway }        from './realtime/workerGateway'
import { SseHub }               from './realtime/sseHub'
import { RealtimePersistence }  from './realtime/realtimePersistence'

// ── Repositories ──────────────────────────────────────────────────────────────
const authRepo         = new AuthRepository(pool)
const refreshTokenRepo = new RefreshTokenRepository(pool)
const usersRepo        = new UsersRepository(pool)
const airlinesRepo     = new AirlinesRepository(pool)
const routinesRepo     = new RoutinesRepository(pool)
const unsubTokensRepo  = new UnsubscribeTokensRepository(pool)
const notifLogRepo     = new NotificationLogRepository(pool)
const airportsRepo     = new AirportsRepository(pool)
const scrapingJobRepo  = new ScrapingJobRepository(pool)
const flightFaresRepo  = new FlightFaresRepository(pool)
const analysisRunsRepo = new AnalysisRunsRepository(pool)
const alertStateRepo   = new TargetAlertStateRepository(pool)

// ── Realtime ────────────────────────────────────────────────────────────────
const hubBus              = new HubBus()
const workerGateway       = new WorkerGateway(hubBus)
const sseHub              = new SseHub(hubBus, scrapingJobRepo)
const realtimePersistence = new RealtimePersistence(hubBus, analysisRunsRepo, scrapingJobRepo)

// ── Services ──────────────────────────────────────────────────────────────────
const scraperClient = new HttpScraperClient(env)
// Exchange: the network sits behind the client, the providers behind the interface,
// and only the service consumes them. The list order IS the fallback order.
const fxHttp = new ExchangeRateHttpClient(env.FX_TIMEOUT_MS)
const fxSvc  = new FxRateService(
  [new FrankfurterProvider(fxHttp), new CurrencyApiProvider(fxHttp)],
)

const flightFaresSvc = new FlightFaresService(flightFaresRepo)
const emailSvc = new EmailService(env)

const notifSvc = new NotificationsService(
  usersRepo,
  routinesRepo,
  flightFaresRepo,
  notifLogRepo,
  unsubTokensRepo,
  emailSvc,
  env,
)

const evaluationSvc = new EvaluationService(
  routinesRepo, flightFaresRepo, alertStateRepo, notifSvc, fxSvc, env.FX_NOISE_MARGIN,
)

const authSvc      = new AuthService(usersRepo, authRepo, refreshTokenRepo, emailSvc)
const usersSvc     = new UsersService(usersRepo, emailSvc)
const airlinesSvc  = new AirlinesService(airlinesRepo, routinesRepo)
const routinesSvc  = new RoutinesService(routinesRepo, airlinesRepo, airportsRepo, flightFaresRepo)
const scrapeSvc    = new ScrapeService(scrapingJobRepo, flightFaresRepo, analysisRunsRepo, fxSvc)
const unsubSvc     = new UnsubscribeService(unsubTokensRepo, routinesRepo, pool)
const schedulerSvc = new SchedulerService(scrapingJobRepo, flightFaresRepo, notifSvc, evaluationSvc, env, analysisRunsRepo, scraperClient, workerGateway, airportsRepo)
const airportsSvc  = new AirportsService(airportsRepo, airlinesRepo)
const analysisRunsSvc = new AnalysisRunsService(routinesRepo, analysisRunsRepo)
const adminSvc        = new AdminService(
  scrapingJobRepo, analysisRunsRepo, workerGateway,
  routinesRepo, notifLogRepo, notifSvc, evaluationSvc, alertStateRepo,
)

export const container = {
  airlinesSvc,
  airportsSvc,
  authSvc,
  usersSvc,
  routinesSvc,
  scrapeSvc,
  unsubSvc,
  schedulerSvc,
  flightFaresSvc,
  analysisRunsSvc,
  adminSvc,
  scrapingJobRepo,
  analysisRunsRepo,
  hubBus,
  workerGateway,
  sseHub,
  realtimePersistence,
} as const
