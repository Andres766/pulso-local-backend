import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { AnalysisEvent, Logger, SessionValidator, TokenPayload, TokenService } from '../../domain/ports/Services.js';
import { SESSION_COOKIE } from '../http/middlewares/security.js';

export const REALTIME_PATH = '/api/ws';

/** Límites por conexión y por usuario: el estado vive en RAM, así que se acota (problema C10K). */
export const REALTIME_LIMITS = {
  maxPayloadBytes: 2048,
  maxConnectionsPerUser: 10,
  maxSubscriptionsPerConnection: 20,
  /** Mensajes del cliente permitidos por ventana; quien los supera se desconecta (1008). */
  maxMessagesPerWindow: 30,
  messageWindowMs: 10_000,
  heartbeatMs: 30_000,
  /** Fan-out por lotes: cada lote se envía y se cede el event loop antes del siguiente. */
  fanOutBatchSize: 500,
  /** Un cliente lento que acumula más de esto sin leer deja de recibir (no se infla la RAM). */
  maxBufferedBytes: 1024 * 1024,
};

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), businessId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('unsubscribe'), businessId: z.string().uuid() }).strict(),
]);

interface ConnectionState {
  userId: string;
  session: TokenPayload;
  subscriptions: Set<string>;
  alive: boolean;
  windowStart: number;
  messagesInWindow: number;
}

export interface RealtimeGatewayDeps {
  redeemTicket(ticket: string): TokenPayload | null;
  tokens: TokenService;
  sessions: SessionValidator;
  /** Guardia anti-IDOR: lanza si el negocio no es del usuario (BusinessAccess). */
  requireOwned(businessId: string, userId: string): Promise<unknown>;
  allowedOrigins: readonly string[];
  logger: Logger;
}

/**
 * Canal WebSocket de PulsoLocal. A diferencia de HTTP (sin estado), cada conexión abierta es un
 * objeto en memoria con su usuario y las "salas" (negocios) a las que se suscribió: Estado por
 * Conexión. Cuando un análisis cambia de estado, el evento se entrega (fan-out) a todas las
 * pestañas suscritas a ese negocio, sin que el navegador tenga que preguntar.
 *
 * Protocolo (JSON):
 *   cliente → { type: 'subscribe' | 'unsubscribe', businessId }
 *   servidor → { type: 'ready' } · { type: 'subscribed', businessId } · { type: 'analysis', businessId, run }
 *              · { type: 'error', code, message }
 */
export class RealtimeGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: REALTIME_LIMITS.maxPayloadBytes });
  private readonly clients = new Map<WebSocket, ConnectionState>();
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RealtimeGatewayDeps) {}

  /** Engancha el canal al servidor HTTP: solo atiende el "Upgrade" en /api/ws. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    this.heartbeat = setInterval(() => this.sweep(), REALTIME_LIMITS.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Entrega un evento a quienes miran ese negocio. Se llama desde el bus (todas las instancias). */
  deliver(event: AnalysisEvent): void {
    const room = this.rooms.get(event.businessId);
    if (!room || room.size === 0) return;
    // Se serializa UNA vez para todos los destinatarios.
    const data = JSON.stringify({ type: 'analysis', businessId: event.businessId, run: event.run });
    this.fanOut([...room], data, 0);
  }

  stats(): { connections: number; rooms: number } {
    return { connections: this.clients.size, rooms: this.rooms.size };
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const ws of this.clients.keys()) ws.close(1001, 'Servidor reiniciándose');
    this.wss.close();
  }

  // ---- Conexión -------------------------------------------------------------------------

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== REALTIME_PATH) return; // otras rutas de upgrade no son nuestras

    // Un WebSocket no aplica CORS: sin revisar el Origin, cualquier página podría abrirlo (CSWSH).
    const origin = req.headers.origin;
    if (!origin || !this.deps.allowedOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');

    const session = await this.authenticate(url.searchParams.get('ticket'), req.headers.cookie);
    if (!session) return reject(socket, 401, 'Unauthorized');

    const open = [...this.clients.values()].filter((c) => c.userId === session.sub).length;
    if (open >= REALTIME_LIMITS.maxConnectionsPerUser) return reject(socket, 429, 'Too Many Requests');

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, session));
  }

  /** Ticket de un solo uso (producción, otro dominio) o la cookie de sesión (mismo origen). */
  private async authenticate(ticket: string | null, cookieHeader: string | undefined): Promise<TokenPayload | null> {
    let session: TokenPayload | null = null;
    if (ticket) session = this.deps.redeemTicket(ticket);
    else {
      const cookie = readCookie(cookieHeader, SESSION_COOKIE);
      session = cookie ? this.deps.tokens.verify(cookie) : null;
    }
    if (!session) return null;
    return (await this.deps.sessions.isValid(session)) ? session : null;
  }

  private onConnection(ws: WebSocket, session: TokenPayload): void {
    const state: ConnectionState = {
      userId: session.sub,
      session,
      subscriptions: new Set(),
      alive: true,
      windowStart: Date.now(),
      messagesInWindow: 0,
    };
    this.clients.set(ws, state);
    ws.on('pong', () => {
      state.alive = true;
    });
    ws.on('message', (raw, isBinary) => void this.onMessage(ws, state, raw, isBinary));
    ws.on('close', () => this.drop(ws));
    ws.on('error', () => this.drop(ws));
    this.send(ws, { type: 'ready' });
  }

  private async onMessage(ws: WebSocket, state: ConnectionState, raw: RawData, isBinary: boolean): Promise<void> {
    const now = Date.now();
    if (now - state.windowStart > REALTIME_LIMITS.messageWindowMs) {
      state.windowStart = now;
      state.messagesInWindow = 0;
    }
    if (++state.messagesInWindow > REALTIME_LIMITS.maxMessagesPerWindow) {
      ws.close(1008, 'Demasiados mensajes');
      return;
    }

    let parsed: z.infer<typeof clientMessage>;
    try {
      if (isBinary) throw new Error('binario');
      parsed = clientMessage.parse(JSON.parse(raw.toString()));
    } catch {
      this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Mensaje no válido' });
      return;
    }

    if (parsed.type === 'unsubscribe') {
      this.leave(ws, state, parsed.businessId);
      return;
    }
    if (state.subscriptions.size >= REALTIME_LIMITS.maxSubscriptionsPerConnection) {
      this.send(ws, { type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS', message: 'Demasiadas suscripciones' });
      return;
    }
    try {
      // La sesión puede haberse cerrado (cambio de contraseña) con el socket abierto.
      if (!(await this.deps.sessions.isValid(state.session))) {
        ws.close(4401, 'Sesión vencida');
        return;
      }
      await this.deps.requireOwned(parsed.businessId, state.userId);
    } catch {
      // Igual que en HTTP: un negocio ajeno responde como si no existiera.
      this.send(ws, { type: 'error', code: 'NOT_FOUND', message: 'Negocio no encontrado', businessId: parsed.businessId });
      return;
    }
    if (!this.clients.has(ws)) return; // se cerró mientras se validaba
    state.subscriptions.add(parsed.businessId);
    const room = this.rooms.get(parsed.businessId) ?? new Set<WebSocket>();
    room.add(ws);
    this.rooms.set(parsed.businessId, room);
    this.send(ws, { type: 'subscribed', businessId: parsed.businessId });
  }

  private leave(ws: WebSocket, state: ConnectionState, businessId: string): void {
    state.subscriptions.delete(businessId);
    const room = this.rooms.get(businessId);
    room?.delete(ws);
    if (room?.size === 0) this.rooms.delete(businessId);
  }

  /** Libera la memoria de la conexión: sin esto, cada pestaña cerrada quedaría como fuga. */
  private drop(ws: WebSocket): void {
    const state = this.clients.get(ws);
    if (!state) return;
    for (const businessId of [...state.subscriptions]) this.leave(ws, state, businessId);
    this.clients.delete(ws);
  }

  /** Latido: conexiones que no respondieron al ping anterior (red caída, portátil dormido) se cierran. */
  private sweep(): void {
    for (const [ws, state] of this.clients) {
      if (!state.alive) {
        ws.terminate();
        this.drop(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }

  // ---- Envío ----------------------------------------------------------------------------

  /**
   * Fan-out por lotes: se envía a `fanOutBatchSize` sockets y se cede el event loop con setImmediate
   * antes del siguiente lote. Con miles de suscriptores, un solo bucle bloquearía a todos los demás
   * usuarios (Node.js tiene un solo hilo para JavaScript).
   */
  private fanOut(sockets: WebSocket[], data: string, from: number): void {
    const end = Math.min(from + REALTIME_LIMITS.fanOutBatchSize, sockets.length);
    for (let i = from; i < end; i++) this.sendRaw(sockets[i]!, data);
    if (end < sockets.length) setImmediate(() => this.fanOut(sockets, data, end));
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    this.sendRaw(ws, JSON.stringify(message));
  }

  private sendRaw(ws: WebSocket, data: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > REALTIME_LIMITS.maxBufferedBytes) return; // cliente lento: no se le acumula más
    ws.send(data);
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}
