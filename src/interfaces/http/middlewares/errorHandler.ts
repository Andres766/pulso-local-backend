import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import {
  AnalyzerError,
  AuthenticationError,
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../domain/errors/DomainError.js';

/** Error de la capa HTTP (p. ej. 401 por falta de sesión, 403 por CSRF). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_DOMAIN_ERROR = new Map<Function, number>([
  [ValidationError, 400],
  [AuthenticationError, 401],
  [NotFoundError, 404],
  [ConflictError, 409],
  [AnalyzerError, 502],
]);

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'ROUTE_NOT_FOUND', 'Recurso no encontrado'));
};

/**
 * Manejador central de errores: una sola forma de respuesta { error: { code, message, details? } }.
 * Los errores no previstos devuelven 500 con un mensaje genérico; la traza solo va al log
 * (nunca se filtran detalles internos al cliente).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Datos de entrada inválidos',
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof DomainError) {
    res.status(STATUS_BY_DOMAIN_ERROR.get(err.constructor) ?? 400).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño máximo (1 MB)' : 'Archivo no válido';
    res.status(400).json({ error: { code: 'UPLOAD_ERROR', message } });
    return;
  }

  // body-parser: JSON mal formado o demasiado grande.
  if (typeof err === 'object' && err && 'type' in err) {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'El cuerpo no es JSON válido' } });
      return;
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'La solicitud es demasiado grande' } });
      return;
    }
  }

  req.log?.error({ err }, 'Error no controlado');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno' } });
};
