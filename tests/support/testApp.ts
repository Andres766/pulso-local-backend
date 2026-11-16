import { pino } from 'pino';
import type { AppDependencies } from '../../src/app.js';
import {
  GetAnalysis,
  GetBusinessesOverview,
  GetDashboard,
  GetSentimentTrend,
} from '../../src/application/use-cases/analysis/AnalysisQueries.js';
import { AnalysisWorker } from '../../src/application/use-cases/analysis/AnalysisWorker.js';
import { ExecuteAnalysis } from '../../src/application/use-cases/analysis/ExecuteAnalysis.js';
import { RequestAnalysis } from '../../src/application/use-cases/analysis/RequestAnalysis.js';
import { AuthenticateUser } from '../../src/application/use-cases/auth/AuthenticateUser.js';
import { GetCurrentUser } from '../../src/application/use-cases/auth/GetCurrentUser.js';
import { RegisterUser } from '../../src/application/use-cases/auth/RegisterUser.js';
import { ChangePassword, DeleteAccount, ValidateSession } from '../../src/application/use-cases/auth/SessionUseCases.js';
import { BusinessAccess } from '../../src/application/use-cases/businesses/BusinessAccess.js';
import {
  CreateBusiness,
  DeleteBusiness,
  GetBusiness,
  ListBusinesses,
  UpdateBusiness,
} from '../../src/application/use-cases/businesses/BusinessUseCases.js';
import {
  ClearReviews,
  DeleteReview,
  ExportReviews,
  ImportReviews,
  ListReviews,
} from '../../src/application/use-cases/reviews/ReviewUseCases.js';
import { InsightAggregator } from '../../src/domain/services/InsightAggregator.js';
import { InsightComparator } from '../../src/domain/services/InsightComparator.js';
import { SentimentTrend } from '../../src/domain/services/SentimentTrend.js';
import { HeuristicReviewAnalyzer } from '../../src/infrastructure/ai/HeuristicReviewAnalyzer.js';
import { CsvReviewExporter } from '../../src/infrastructure/csv/CsvReviewExporter.js';
import { CsvReviewParser, PastedTextParser } from '../../src/infrastructure/csv/ReviewTextParsers.js';
import { PublishingAnalysisRepository } from '../../src/infrastructure/realtime/PublishingAnalysisRepository.js';
import { InMemoryRealtimeBus } from '../../src/infrastructure/realtime/RealtimeBus.js';
import { JwtTokenService } from '../../src/infrastructure/security/JwtTokenService.js';
import { RealtimeTicketService } from '../../src/infrastructure/security/RealtimeTicketService.js';
import { AnalysisController } from '../../src/interfaces/http/controllers/AnalysisController.js';
import { AuthController } from '../../src/interfaces/http/controllers/AuthController.js';
import { BusinessController } from '../../src/interfaces/http/controllers/BusinessController.js';
import { HealthController } from '../../src/interfaces/http/controllers/HealthController.js';
import { RealtimeController } from '../../src/interfaces/http/controllers/RealtimeController.js';
import { ReviewController } from '../../src/interfaces/http/controllers/ReviewController.js';
import { RealtimeGateway } from '../../src/interfaces/realtime/RealtimeGateway.js';
import { FakeHasher, InMemoryAnalyses, InMemoryBusinesses, InMemoryReviews, InMemoryUsers, silentLogger } from '../fakes.js';

export const FRONTEND_ORIGIN = 'http://localhost:5180';
const SECRET = 'clave-de-prueba-con-mas-de-32-caracteres';

export interface TestApp {
  deps: AppDependencies;
  realtime: RealtimeGateway;
  bus: InMemoryRealtimeBus;
}

/**
 * Arma la aplicación completa (casos de uso, controladores, canal en tiempo real) sobre
 * repositorios en memoria. La usan las pruebas HTTP y las de WebSockets.
 */
export function buildTestApp(): TestApp {
  const users = new InMemoryUsers();
  const businesses = new InMemoryBusinesses();
  const reviews = new InMemoryReviews();
  const bus = new InMemoryRealtimeBus();
  // Igual que en el contenedor: los cambios de estado de los análisis se publican en el bus.
  const analyses = new PublishingAnalysisRepository(new InMemoryAnalyses(reviews), bus);
  const hasher = new FakeHasher();
  const tokens = new JwtTokenService(SECRET, 1);
  const analyzer = new HeuristicReviewAnalyzer();
  const access = new BusinessAccess(businesses);
  const execute = new ExecuteAnalysis(analyses, businesses, reviews, analyzer, new InsightAggregator(), silentLogger, 500);
  const worker = new AnalysisWorker(analyses, execute, silentLogger);
  // Cola de prueba: al recibir el aviso vacía la cola en el acto (como haría PollingJobRunner).
  const jobs = { wake: () => void worker.drain() };

  const tickets = new RealtimeTicketService(SECRET);
  const sessions = new ValidateSession(users);
  const realtime = new RealtimeGateway({
    redeemTicket: (ticket) => tickets.redeem(ticket),
    tokens,
    sessions,
    requireOwned: (businessId, userId) => access.requireOwned(businessId, userId),
    allowedOrigins: [FRONTEND_ORIGIN],
    logger: silentLogger,
  });
  bus.subscribe((event) => realtime.deliver(event));

  const deps: AppDependencies = {
    config: { FRONTEND_ORIGIN, TRUST_PROXY: false },
    logger: pino({ level: 'silent' }),
    tokens,
    sessions,
    healthController: new HealthController({ ping: async () => true }, analyzer.providerName, '9.9.9'),
    authController: new AuthController(
      new RegisterUser(users, hasher),
      new AuthenticateUser(users, hasher, tokens),
      new GetCurrentUser(users),
      new ChangePassword(users, hasher, tokens),
      new DeleteAccount(users, hasher),
      { secure: false, maxAgeMs: tokens.maxAgeMs },
    ),
    businessController: new BusinessController(
      new CreateBusiness(businesses),
      new ListBusinesses(businesses),
      new GetBusiness(access),
      new DeleteBusiness(access, businesses),
      new UpdateBusiness(access, businesses),
    ),
    reviewController: new ReviewController(
      new ImportReviews(access, reviews),
      new ListReviews(access, reviews),
      new ClearReviews(access, reviews),
      new ExportReviews(access, reviews),
      new CsvReviewParser(),
      new PastedTextParser(),
      new CsvReviewExporter(),
      new DeleteReview(access, reviews),
    ),
    analysisController: new AnalysisController(
      new RequestAnalysis(access, reviews, analyses, analyzer, jobs),
      new GetAnalysis(access, analyses),
      new GetDashboard(access, reviews, analyses, new InsightComparator()),
      new GetSentimentTrend(access, analyses, new SentimentTrend()),
      new GetBusinessesOverview(businesses, reviews, analyses, new InsightComparator()),
    ),
    realtimeController: new RealtimeController(tokens, tickets, null),
  };
  return { deps, realtime, bus };
}
