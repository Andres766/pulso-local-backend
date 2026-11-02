import type { AnalysisRepository } from '../../../domain/ports/Repositories.js';
import type { Logger } from '../../../domain/ports/Services.js';
import type { ExecuteAnalysis } from './ExecuteAnalysis.js';

/**
 * Consumidor de la cola persistente de análisis. No sabe cuándo ni cómo se le invoca
 * (sondeo, aviso de wake(), pruebas): solo toma trabajos de la base de datos y los ejecuta.
 */
export class AnalysisWorker {
  constructor(
    private readonly analyses: AnalysisRepository,
    private readonly executeAnalysis: ExecuteAnalysis,
    private readonly logger: Logger,
  ) {}

  /** Procesa un análisis pendiente. Devuelve false si la cola estaba vacía. */
  async runNext(): Promise<boolean> {
    const run = await this.analyses.claimNext();
    if (!run) return false;
    this.logger.info({ runId: run.id, attempt: run.attempts }, 'Análisis tomado de la cola');
    await this.executeAnalysis.process(run);
    return true;
  }

  /** Procesa hasta vaciar la cola (o hasta `max` trabajos). Devuelve cuántos procesó. */
  async drain(max = Number.POSITIVE_INFINITY): Promise<number> {
    let processed = 0;
    while (processed < max && (await this.runNext())) processed++;
    return processed;
  }
}
