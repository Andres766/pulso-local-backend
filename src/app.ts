import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger as PinoLogger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config/env.js';
import type { TokenService } from './domain/ports/Services.js';
import type { AnalysisController } from './interfaces/http/controllers/AnalysisController.js';
import type { AuthController } from './interfaces/http/controllers/AuthController.js';
import type { BusinessController } from './interfaces/http/controllers/BusinessController.js';
import type { ReviewController } from './interfaces/http/controllers/ReviewController.js';
import { createApiRouter } from './interfaces/http/routes.js';
import { errorHandler, notFoundHandler } from './interfaces/http/middlewares/errorHandler.js';
import { apiLimiter, CSRF_HEADER, requireCsrfHeader } from './interfaces/http/middlewares/security.js';

/**
 * Lo que la capa HTTP necesita para funcionar. `Container` lo cumple en producción;
 * las pruebas de integración arman uno con repositorios en memoria (sin base de datos).
 */
export interface AppDependencies {
  config: Pick<AppConfig, 'FRONTEND_ORIGIN' | 'TRUST_PROXY'>;
  logger: PinoLogger;
  db: { ping(): Promise<boolean> };
  tokens: TokenService;
  analyzer: { readonly providerName: string };
  authController: AuthController;
  businessController: BusinessController;
  reviewController: ReviewController;
  analysisController: AnalysisController;
}

/** Construye la aplicación Express a partir de sus dependencias ya armadas (inyección de dependencias). */
export function createApp(c: AppDependencies): Express {
  const app = express();
  const { config } = c;

  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(pinoHttp({ logger: c.logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  // Cabeceras de seguridad: CSP estricta (la API solo devuelve JSON), HSTS, nosniff, frameguard…
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

  // CORS con lista blanca de un solo origen (el frontend) y credenciales.
  app.use(
    cors({
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', CSRF_HEADER],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '300kb' }));
  app.use(cookieParser());
  app.use('/api', apiLimiter, requireCsrfHeader, createApiRouter(c));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
