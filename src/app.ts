import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Container } from './container.js';
import { createApiRouter } from './interfaces/http/routes.js';
import { errorHandler, notFoundHandler } from './interfaces/http/middlewares/errorHandler.js';
import { apiLimiter, CSRF_HEADER, requireCsrfHeader } from './interfaces/http/middlewares/security.js';

/**
 * Construye la aplicación Express. Recibe el contenedor ya armado (inyección de dependencias),
 * lo que permite crear la app en los tests con dependencias falsas.
 */
export function createApp(c: Container): Express {
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
