import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { TokenPayload } from '../../domain/ports/Services.js';

const ISSUER = 'pulsolocal-api';
/** Audiencia distinta a la de la cookie: un ticket no sirve como sesión ni al revés. */
const AUDIENCE = 'pulsolocal-realtime';
export const TICKET_TTL_SECONDS = 60;

/**
 * Ticket de un solo uso para abrir el WebSocket. En producción el frontend (Vercel) y la API
 * (Render) están en dominios distintos y Vercel no reenvía WebSockets, así que el navegador se
 * conecta directo a Render, adonde la cookie SameSite=Strict no viaja. El frontend pide el ticket
 * por /api (con su cookie y el header anti-CSRF) y lo presenta al abrir la conexión.
 *
 * Es un JWT firmado (lo valida cualquier instancia), vence en 60 s y su `jti` se descarta al usarse
 * en esta instancia, así que capturarlo de un log no permite reutilizarlo.
 */
export class RealtimeTicketService {
  private readonly used = new Map<string, number>();

  constructor(private readonly secret: string) {}

  issue(session: TokenPayload): string {
    return jwt.sign({ email: session.email, ver: session.ver }, this.secret, {
      algorithm: 'HS256',
      subject: session.sub,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: TICKET_TTL_SECONDS,
      jwtid: randomUUID(),
    });
  }

  /** Devuelve la sesión del ticket y lo invalida; null si es falso, venció o ya se usó. */
  redeem(ticket: string, now = Date.now()): TokenPayload | null {
    let decoded: jwt.JwtPayload | string;
    try {
      decoded = jwt.verify(ticket, this.secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    } catch {
      return null;
    }
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string' || typeof decoded.jti !== 'string') return null;

    this.forgetExpired(now);
    if (this.used.has(decoded.jti)) return null;
    this.used.set(decoded.jti, (decoded.exp ?? 0) * 1000);

    return {
      sub: decoded.sub,
      email: typeof decoded.email === 'string' ? decoded.email : '',
      ver: typeof decoded.ver === 'number' ? decoded.ver : 0,
    };
  }

  private forgetExpired(now: number): void {
    for (const [jti, expiresAt] of this.used) if (expiresAt < now) this.used.delete(jti);
  }
}
