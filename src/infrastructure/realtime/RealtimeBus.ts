import type { AnalysisEvent, AnalysisEventPublisher } from '../../domain/ports/Services.js';

export type AnalysisEventHandler = (event: AnalysisEvent) => void;

/**
 * Canal de eventos entre la aplicación y quienes los entregan a los navegadores. Publicar y recibir
 * están separados a propósito: con varias instancias del servidor, el evento publicado en una debe
 * llegar a TODAS (ver PgNotifyRealtimeBus), porque cada una tiene en memoria sus propias conexiones.
 */
export interface RealtimeBus extends AnalysisEventPublisher {
  subscribe(handler: AnalysisEventHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Bus de una sola instancia: entrega en el mismo proceso. Se usa en pruebas y como respaldo. */
export class InMemoryRealtimeBus implements RealtimeBus {
  private readonly handlers: AnalysisEventHandler[] = [];

  publish(event: AnalysisEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  subscribe(handler: AnalysisEventHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
