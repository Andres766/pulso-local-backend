import type { Request, Response } from 'express';

/**
 * Estado del servicio, público y sin datos sensibles. Render lo usa como health check
 * (503 si la base de datos no responde) y sirve para confirmar qué versión quedó desplegada.
 */
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: { ping(): Promise<boolean> },
    private readonly aiProvider: string,
    private readonly version: string,
    /** Conexiones WebSocket abiertas en esta instancia (estado por conexión). */
    private readonly realtime: { stats(): { connections: number } } = { stats: () => ({ connections: 0 }) },
  ) {}

  check = async (_req: Request, res: Response) => {
    const db = await this.db.ping();
    res.status(db ? 200 : 503).json({
      status: db ? 'ok' : 'degraded',
      db,
      ai: this.aiProvider,
      version: this.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      realtimeConnections: this.realtime.stats().connections,
    });
  };
}
