import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { TokenService } from '../../../domain/ports/Services.js';
import { HttpError } from './errorHandler.js';

export const SESSION_COOKIE = 'pulso_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'PulsoLocal';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Autenticación: el JWT viaja en una cookie httpOnly (JavaScript del navegador no puede
 * leerla → un XSS no roba la sesión). Si es válida, deja el id del usuario en req.userId.
 */
export function requireAuth(tokens: TokenService): RequestHandler {
  return (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    const payload = typeof token === 'string' ? tokens.verify(token) : null;
    if (!payload) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Debes iniciar sesión'));
      return;
    }
    req.userId = payload.sub;
    next();
  };
}

/**
 * Protección CSRF para peticiones que modifican estado. Dos capas:
 *  1. La cookie es SameSite=Strict (el navegador no la envía desde otros sitios).
 *  2. Se exige un header personalizado: un formulario de otro sitio no puede ponerlo, y un
 *     fetch cross-origin con ese header dispara un preflight CORS que nuestro servidor rechaza.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (safe || req.get(CSRF_HEADER) === CSRF_HEADER_VALUE) {
    next();
    return;
  }
  next(new HttpError(403, 'CSRF_REJECTED', 'Solicitud rechazada'));
};

/** Evita que respuestas con datos privados queden en cachés intermedias. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

const limitMessage = (message: string) => ({ error: { code: 'RATE_LIMITED', message } });

/** Límite general de la API por IP. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: limitMessage('Demasiadas solicitudes, intenta más tarde'),
});

/** Correo normalizado del cuerpo (login/registro) para usarlo como parte de la clave del límite. */
const emailOf = (body: unknown): string => {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
};

/**
 * Límite estricto por IP + cuenta: 10 intentos fallidos cada 15 minutos contra un mismo correo.
 * Se combina la IP con el correo porque detrás de un proxy (Vercel) muchos usuarios comparten IP:
 * así los errores de uno no bloquean a los demás. Solo cuentan los intentos fallidos.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${emailOf(req.body) || req.userId || '-'}`,
  message: limitMessage('Demasiados intentos. Espera 15 minutos.'),
});

/**
 * Límite amplio solo por IP: frena el relleno de credenciales (probar muchas cuentas distintas
 * desde un mismo origen), que el límite por cuenta no detecta.
 */
export const authIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 50,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: limitMessage('Demasiados intentos desde tu red. Espera 15 minutos.'),
});

/** Límite para lanzar análisis: cada uno consume llamadas pagas al LLM. */
export const analysisLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? 'anon',
  message: limitMessage('Alcanzaste el máximo de análisis por hora'),
});
