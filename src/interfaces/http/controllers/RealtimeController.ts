import type { Request, Response } from 'express';
import type { TokenPayload, TokenService } from '../../../domain/ports/Services.js';
import { TICKET_TTL_SECONDS } from '../../../infrastructure/security/RealtimeTicketService.js';
import { HttpError } from '../middlewares/errorHandler.js';
import { SESSION_COOKIE } from '../middlewares/security.js';

/** Entrega el ticket de un solo uso para abrir el canal WebSocket (ver RealtimeTicketService). */
export class RealtimeController {
  constructor(
    private readonly tokens: TokenService,
    private readonly tickets: { issue(session: TokenPayload): string },
    /** URL pública del WebSocket (wss://…) o null si el navegador debe usar su mismo origen. */
    private readonly publicUrl: string | null,
  ) {}

  ticket = (req: Request, res: Response) => {
    // requireAuth ya validó la sesión; aquí se relee la cookie para copiar su versión al ticket.
    const cookie: unknown = req.cookies?.[SESSION_COOKIE];
    const session = typeof cookie === 'string' ? this.tokens.verify(cookie) : null;
    if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Debes iniciar sesión');
    res.status(201).json({ ticket: this.tickets.issue(session), url: this.publicUrl, expiresInSeconds: TICKET_TTL_SECONDS });
  };
}
