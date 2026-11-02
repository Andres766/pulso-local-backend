import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Solo se acepta un ID entrante con forma segura: evita inyectar texto arbitrario en los logs. */
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Genera (o reutiliza, si un proxy de confianza ya lo trae) el identificador de la petición y lo
 * devuelve en la cabecera X-Request-Id. pino-http lo adjunta a cada línea de log de esa petición,
 * así un error reportado por un usuario se encuentra en los logs con un solo dato.
 */
export function genRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}
