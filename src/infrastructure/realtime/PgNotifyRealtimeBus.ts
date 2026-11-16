import pg from 'pg';
import type { AnalysisEvent, Logger } from '../../domain/ports/Services.js';
import type { AnalysisEventHandler, RealtimeBus } from './RealtimeBus.js';

/** Canal de PostgreSQL por el que viajan los eventos de análisis. */
export const ANALYSIS_CHANNEL = 'pulso_analysis';
/** NOTIFY admite hasta 8000 bytes; un evento de análisis ocupa unos 400. */
const MAX_PAYLOAD_BYTES = 7900;
const RECONNECT_MS = 3000;

/**
 * Backplane Pub/Sub con LISTEN/NOTIFY de PostgreSQL (el mismo papel que Redis Pub/Sub en la teoría
 * de escalado horizontal, sin sumar otro servicio). Cada instancia publica con pg_notify y escucha
 * el canal con una conexión dedicada: si el análisis corre en el servidor A y el navegador está
 * conectado al servidor B, B también recibe el evento y lo entrega.
 */
export class PgNotifyRealtimeBus implements RealtimeBus {
  private readonly handlers: AnalysisEventHandler[] = [];
  private listener: pg.Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly db: { query(text: string, params?: unknown[]): Promise<unknown> },
    private readonly logger: Logger,
  ) {}

  publish(event: AnalysisEvent): void {
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      this.logger.warn({ runId: event.run.id }, 'Evento demasiado grande para NOTIFY; se omite');
      return;
    }
    // Consulta parametrizada: el contenido nunca se concatena en el SQL.
    this.db.query('SELECT pg_notify($1, $2)', [ANALYSIS_CHANNEL, payload]).catch((err: unknown) => {
      this.logger.warn({ err }, 'No se pudo publicar el evento en tiempo real');
    });
  }

  subscribe(handler: AnalysisEventHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const client = this.listener;
    this.listener = null;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => this.dispatch(msg.payload));
    // Si la conexión de escucha se cae (reinicio de la base, red), se vuelve a abrir.
    client.on('error', (err) => {
      this.logger.warn({ err }, 'Se perdió la conexión LISTEN; reintentando');
      this.scheduleReconnect(client);
    });
    client.on('end', () => this.scheduleReconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${ANALYSIS_CHANNEL}`);
      this.listener = client;
    } catch (err) {
      this.logger.warn({ err }, 'No se pudo escuchar el canal en tiempo real; reintentando');
      this.scheduleReconnect(client);
    }
  }

  private scheduleReconnect(client: pg.Client): void {
    if (this.stopped || this.reconnectTimer || (this.listener && this.listener !== client)) return;
    this.listener = null;
    void client.end().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_MS);
  }

  private dispatch(payload: string | undefined): void {
    if (!payload) return;
    let event: AnalysisEvent;
    try {
      event = JSON.parse(payload) as AnalysisEvent;
    } catch {
      return;
    }
    if (typeof event?.businessId !== 'string' || typeof event.run?.id !== 'string') return;
    for (const handler of this.handlers) handler(event);
  }
}
