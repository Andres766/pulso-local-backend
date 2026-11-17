import { type Logger as PinoLogger, pino } from 'pino';
import type { AppDependencies } from './app.js';
import {
  AdminAccess,
  GetAdminDashboard,
  ListUsersForAdmin,
  PromoteConfiguredAdmins,
  RetryFailedAnalysis,
  UnlockUser,
} from './application/use-cases/admin/AdminUseCases.js';
import { GetAnalysis, GetBusinessesOverview, GetDashboard, GetSentimentTrend } from './application/use-cases/analysis/AnalysisQueries.js';
import { AnalysisWorker } from './application/use-cases/analysis/AnalysisWorker.js';
import { ExecuteAnalysis } from './application/use-cases/analysis/ExecuteAnalysis.js';
import { MAX_REVIEWS_PER_ANALYSIS, RequestAnalysis } from './application/use-cases/analysis/RequestAnalysis.js';
import { AuthenticateUser } from './application/use-cases/auth/AuthenticateUser.js';
import { GetCurrentUser } from './application/use-cases/auth/GetCurrentUser.js';
import { RegisterUser } from './application/use-cases/auth/RegisterUser.js';
import { ChangePassword, DeleteAccount, ValidateSession } from './application/use-cases/auth/SessionUseCases.js';
import { BusinessAccess } from './application/use-cases/businesses/BusinessAccess.js';
import {
  CreateBusiness,
  DeleteBusiness,
  GetBusiness,
  ListBusinesses,
  UpdateBusiness,
} from './application/use-cases/businesses/BusinessUseCases.js';
import { ClearReviews, DeleteReview, ExportReviews, ImportReviews, ListReviews } from './application/use-cases/reviews/ReviewUseCases.js';
import type { AppConfig } from './config/env.js';
import { readAppVersion } from './config/version.js';
import type { ReviewAnalyzer } from './domain/ports/ReviewAnalyzer.js';
import { InsightAggregator } from './domain/services/InsightAggregator.js';
import { InsightComparator } from './domain/services/InsightComparator.js';
import { SentimentTrend } from './domain/services/SentimentTrend.js';
import { createReviewAnalyzer } from './infrastructure/ai/ReviewAnalyzerFactory.js';
import { CsvReviewExporter } from './infrastructure/csv/CsvReviewExporter.js';
import { CsvReviewParser, PastedTextParser } from './infrastructure/csv/ReviewTextParsers.js';
import { Database } from './infrastructure/db/Database.js';
import { PgAdminReadModel } from './infrastructure/db/repositories/PgAdminReadModel.js';
import { PgAnalysisRepository } from './infrastructure/db/repositories/PgAnalysisRepository.js';
import { PgBusinessRepository } from './infrastructure/db/repositories/PgBusinessRepository.js';
import { PgReviewRepository } from './infrastructure/db/repositories/PgReviewRepository.js';
import { PgUserRepository } from './infrastructure/db/repositories/PgUserRepository.js';
import { PollingJobRunner } from './infrastructure/jobs/PollingJobRunner.js';
import { PgNotifyRealtimeBus } from './infrastructure/realtime/PgNotifyRealtimeBus.js';
import { PublishingAnalysisRepository } from './infrastructure/realtime/PublishingAnalysisRepository.js';
import type { RealtimeBus } from './infrastructure/realtime/RealtimeBus.js';
import { BcryptPasswordHasher } from './infrastructure/security/BcryptPasswordHasher.js';
import { JwtTokenService } from './infrastructure/security/JwtTokenService.js';
import { RealtimeTicketService } from './infrastructure/security/RealtimeTicketService.js';
import { AdminController } from './interfaces/http/controllers/AdminController.js';
import { AnalysisController } from './interfaces/http/controllers/AnalysisController.js';
import { AuthController } from './interfaces/http/controllers/AuthController.js';
import { BusinessController } from './interfaces/http/controllers/BusinessController.js';
import { HealthController } from './interfaces/http/controllers/HealthController.js';
import { RealtimeController } from './interfaces/http/controllers/RealtimeController.js';
import { ReviewController } from './interfaces/http/controllers/ReviewController.js';
import { RealtimeGateway } from './interfaces/realtime/RealtimeGateway.js';

/**
 * Raíz de composición (Composition Root): el ÚNICO lugar donde se instancian las clases
 * concretas y se conectan entre sí. El resto del código solo conoce interfaces (puertos),
 * lo que materializa el principio de inversión de dependencias (la D de SOLID).
 */
export class Container implements AppDependencies {
  readonly logger: PinoLogger;
  readonly db: Database;
  readonly tokens: JwtTokenService;
  readonly sessions: ValidateSession;
  readonly analyzer: ReviewAnalyzer;
  readonly analyses: PgAnalysisRepository;
  readonly jobs: PollingJobRunner;
  /** Backplane Pub/Sub entre instancias (LISTEN/NOTIFY) y canal WebSocket hacia los navegadores. */
  readonly realtimeBus: RealtimeBus;
  readonly realtime: RealtimeGateway;

  readonly authController: AuthController;
  readonly businessController: BusinessController;
  readonly reviewController: ReviewController;
  readonly analysisController: AnalysisController;
  readonly healthController: HealthController;
  readonly realtimeController: RealtimeController;
  readonly adminController: AdminController;
  /** Se ejecuta al arrancar (server.ts): da el rol de admin a los correos de ADMIN_EMAILS. */
  readonly promoteAdmins: PromoteConfiguredAdmins;

  constructor(readonly config: AppConfig) {
    this.logger = pino({
      level: config.LOG_LEVEL,
      // Nunca registrar credenciales ni cookies de sesión.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.password', '*.passwordHash'],
      transport: config.isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    });

    // Infraestructura
    this.db = new Database(config.DATABASE_URL);
    const users = new PgUserRepository(this.db);
    const businesses = new PgBusinessRepository(this.db);
    const reviews = new PgReviewRepository(this.db);
    this.analyses = new PgAnalysisRepository(this.db);
    const hasher = new BcryptPasswordHasher();
    this.tokens = new JwtTokenService(config.JWT_SECRET, config.JWT_EXPIRES_IN_HOURS);
    this.sessions = new ValidateSession(users);
    this.analyzer = createReviewAnalyzer(config, this.logger);
    this.realtimeBus = new PgNotifyRealtimeBus(config.DATABASE_URL, this.db, this.logger);
    // Los casos de uso que cambian el estado de un análisis usan el repositorio decorado: cada
    // cambio guardado se publica en el bus sin que la aplicación sepa de WebSockets.
    const trackedAnalyses = new PublishingAnalysisRepository(this.analyses, this.realtimeBus);
    const tickets = new RealtimeTicketService(config.JWT_SECRET);

    // Aplicación
    const access = new BusinessAccess(businesses);
    const executeAnalysis = new ExecuteAnalysis(
      trackedAnalyses,
      businesses,
      reviews,
      this.analyzer,
      new InsightAggregator(),
      this.logger,
      MAX_REVIEWS_PER_ANALYSIS,
    );
    this.jobs = new PollingJobRunner(new AnalysisWorker(trackedAnalyses, executeAnalysis, this.logger), this.logger);

    // Interfaces HTTP
    this.authController = new AuthController(
      new RegisterUser(users, hasher),
      new AuthenticateUser(users, hasher, this.tokens),
      new GetCurrentUser(users),
      new ChangePassword(users, hasher, this.tokens),
      new DeleteAccount(users, hasher),
      { secure: config.cookieSecure, maxAgeMs: this.tokens.maxAgeMs },
    );
    this.businessController = new BusinessController(
      new CreateBusiness(businesses),
      new ListBusinesses(businesses),
      new GetBusiness(access),
      new DeleteBusiness(access, businesses),
      new UpdateBusiness(access, businesses),
    );
    this.reviewController = new ReviewController(
      new ImportReviews(access, reviews),
      new ListReviews(access, reviews),
      new ClearReviews(access, reviews),
      new ExportReviews(access, reviews),
      new CsvReviewParser(),
      new PastedTextParser(),
      new CsvReviewExporter(),
      new DeleteReview(access, reviews),
    );
    this.analysisController = new AnalysisController(
      new RequestAnalysis(access, reviews, trackedAnalyses, this.analyzer, this.jobs),
      new GetAnalysis(access, this.analyses),
      new GetDashboard(access, reviews, this.analyses, new InsightComparator()),
      new GetSentimentTrend(access, this.analyses, new SentimentTrend()),
      new GetBusinessesOverview(businesses, reviews, this.analyses, new InsightComparator()),
    );
    this.realtimeController = new RealtimeController(this.tokens, tickets, config.realtimeUrl);

    // Administración (RBAC): cifras agregadas, desbloqueo de cuentas y reintento de análisis fallidos.
    const adminAccess = new AdminAccess(users);
    const adminReadModel = new PgAdminReadModel(this.db);
    this.adminController = new AdminController(
      new GetAdminDashboard(adminAccess, adminReadModel),
      new ListUsersForAdmin(adminAccess, adminReadModel),
      new UnlockUser(adminAccess, users),
      new RetryFailedAnalysis(adminAccess, trackedAnalyses, reviews, this.analyzer, this.jobs),
    );
    this.promoteAdmins = new PromoteConfiguredAdmins(users);

    // Tiempo real: el gateway entrega a los navegadores lo que llega por el bus (de cualquier instancia).
    this.realtime = new RealtimeGateway({
      redeemTicket: (ticket) => tickets.redeem(ticket),
      tokens: this.tokens,
      sessions: this.sessions,
      requireOwned: (businessId, userId) => access.requireOwned(businessId, userId),
      allowedOrigins: [config.FRONTEND_ORIGIN],
      logger: this.logger,
    });
    this.realtimeBus.subscribe((event) => this.realtime.deliver(event));

    this.healthController = new HealthController(this.db, this.analyzer.providerName, readAppVersion(), this.realtime);
  }
}
