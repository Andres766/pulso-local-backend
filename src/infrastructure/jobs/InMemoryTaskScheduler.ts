import type { Logger, TaskScheduler } from '../../domain/ports/Services.js';

/**
 * Cola en memoria con concurrencia limitada. Suficiente para un solo proceso;
 * al estar detrás del puerto TaskScheduler, se puede cambiar por BullMQ/Redis
 * sin tocar los casos de uso. Los análisis interrumpidos por un reinicio se marcan
 * como fallidos al arrancar (ver server.ts).
 */
export class InMemoryTaskScheduler implements TaskScheduler {
  private readonly queue: { name: string; task: () => Promise<void> }[] = [];
  private running = 0;

  constructor(
    private readonly logger: Logger,
    private readonly concurrency = 2,
  ) {}

  schedule(name: string, task: () => Promise<void>): void {
    this.queue.push({ name, task });
    this.drain();
  }

  get pending(): number {
    return this.queue.length + this.running;
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      // setImmediate: la respuesta HTTP sale antes de que empiece el trabajo pesado.
      setImmediate(() => {
        job
          .task()
          .catch((err: unknown) => this.logger.error({ err, job: job.name }, 'Tarea en segundo plano falló'))
          .finally(() => {
            this.running--;
            this.drain();
          });
      });
    }
  }
}
