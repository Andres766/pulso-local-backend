import { type Logger as PinoLogger, pino } from 'pino';
import type { AppDependencies } from './app.js';
import { GetAnalysis, GetDashboard, GetSentimentTrend } from './application/use-cases/analysis/AnalysisQueries.js';
import { AnalysisWorker } from './application/use-cases/analysis/AnalysisWorker.js';
import { ExecuteAnalysis } from './application/use-cases/analysis/ExecuteAnalysis.js';
import { MAX_REVIEWS_PER_ANALYSIS, RequestAnalysis } from './application/use-cases/analysis/RequestAnalysis.js';
import { AuthenticateUser } from './application/use-cases/auth/AuthenticateUser.js';
import { GetCurrentUser } from './application/use-cases/auth/GetCurrentUser.js';
import { RegisterUser } from './application/use-cases/auth/RegisterUser.js';
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
import type { ReviewAnalyzer } from './domain/ports/ReviewAnalyzer.js';
import { InsightAggregator } from './domain/services/InsightAggregator.js';
import { InsightComparator } from './domain/services/InsightComparator.js';
import { SentimentTrend } from './domain/services/SentimentTrend.js';
import { createReviewAnalyzer } from './infrastructure/ai/ReviewAnalyzerFactory.js';
import { CsvReviewExporter } from './infrastructure/csv/CsvReviewExporter.js';
import { CsvReviewParser, PastedTextParser } from './infrastructure/csv/ReviewTextParsers.js';
import { Database } from './infrastructure/db/Database.js';
import { PgAnalysisRepository } from './infrastructure/db/repositories/PgAnalysisRepository.js';
import { PgBusinessRepository } from './infrastructure/db/repositories/PgBusinessRepository.js';
import { PgReviewRepository } from './infrastructure/db/repositories/PgReviewRepository.js';
import { PgUserRepository } from './infrastructure/db/repositories/PgUserRepository.js';
import { PollingJobRunner } from './infrastructure/jobs/PollingJobRunner.js';
import { BcryptPasswordHasher } from './infrastructure/security/BcryptPasswordHasher.js';
import { JwtTokenService } from './infrastructure/security/JwtTokenService.js';
import { AnalysisController } from './interfaces/http/controllers/AnalysisController.js';
import { AuthController } from './interfaces/http/controllers/AuthController.js';
import { BusinessController } from './interfaces/http/controllers/BusinessController.js';
import { ReviewController } from './interfaces/http/controllers/ReviewController.js';

/**
 * Raíz de composición (Composition Root): el ÚNICO lugar donde se instancian las clases
 * concretas y se conectan entre sí. El resto del código solo conoce interfaces (puertos),
 * lo que materializa el principio de inversión de dependencias (la D de SOLID).
 */
export class Container implements AppDependencies {
  readonly logger: PinoLogger;
  readonly db: Database;
  readonly tokens: JwtTokenService;
  readonly analyzer: ReviewAnalyzer;
  readonly analyses: PgAnalysisRepository;
  readonly jobs: PollingJobRunner;

  readonly authController: AuthController;
  readonly businessController: BusinessController;
  readonly reviewController: ReviewController;
  readonly analysisController: AnalysisController;

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
    this.analyzer = createReviewAnalyzer(config, this.logger);

    // Aplicación
    const access = new BusinessAccess(businesses);
    const executeAnalysis = new ExecuteAnalysis(
      this.analyses,
      businesses,
      reviews,
      this.analyzer,
      new InsightAggregator(),
      this.logger,
      MAX_REVIEWS_PER_ANALYSIS,
    );
    this.jobs = new PollingJobRunner(new AnalysisWorker(this.analyses, executeAnalysis, this.logger), this.logger);

    // Interfaces HTTP
    this.authController = new AuthController(
      new RegisterUser(users, hasher),
      new AuthenticateUser(users, hasher, this.tokens),
      new GetCurrentUser(users),
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
      new RequestAnalysis(access, reviews, this.analyses, this.analyzer, this.jobs),
      new GetAnalysis(access, this.analyses),
      new GetDashboard(access, reviews, this.analyses, new InsightComparator()),
      new GetSentimentTrend(access, this.analyses, new SentimentTrend()),
    );
  }
}
