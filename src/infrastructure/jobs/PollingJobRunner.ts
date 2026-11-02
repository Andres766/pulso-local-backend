import type { AnalysisWorker } from '../../application/use-cases/analysis/AnalysisWorker.js';
import type { JobQueue, Logger } from '../../domain/ports/Services.js';

/**
 * Motor del worker: vacía la cola persistente cada `intervalMs` y también apenas llega un aviso
 * (wake), sin solaparse consigo mismo. Los trabajos viven en PostgreSQL, así que un reinicio no
 * los pierde; este objeto solo decide CUÁNDO mirar la cola.
 */
export class PollingJobRunner implements JobQueue {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private pendingWake = false;
  private stopped = true;

  constructor(
    private readonly worker: AnalysisWorker,
    private readonly logger: Logger,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Deja de sondear y espera a que termine el trabajo en curso (apagado ordenado). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.draining;
  }

  wake(): void {
    if (this.stopped) return;
    if (this.draining) {
      // Ya hay una pasada en curso: cuando termine, se hará otra para tomar el trabajo nuevo.
      this.pendingWake = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = (async () => {
      try {
        do {
          this.pendingWake = false;
          await this.worker.drain();
        } while (this.pendingWake && !this.stopped);
      } catch (err) {
        this.logger.error({ err }, 'Error procesando la cola de análisis');
      }
    })();
    await this.draining;
    this.draining = null;
    if (!this.stopped) this.schedule(this.intervalMs);
  }
}
