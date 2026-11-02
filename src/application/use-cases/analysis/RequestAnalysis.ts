import { AnalysisRun } from '../../../domain/entities/AnalysisRun.js';
import { ConflictError } from '../../../domain/errors/DomainError.js';
import type { AnalysisRepository, ReviewRepository } from '../../../domain/ports/Repositories.js';
import type { ReviewAnalyzer } from '../../../domain/ports/ReviewAnalyzer.js';
import type { JobQueue } from '../../../domain/ports/Services.js';
import type { BusinessAccess } from '../businesses/BusinessAccess.js';

/** Tope de reseñas por análisis: controla costo y latencia de la IA. */
export const MAX_REVIEWS_PER_ANALYSIS = 500;

/**
 * Solicita un análisis y responde de inmediato (202 Accepted): el análisis queda "pending" en la
 * base de datos (cola persistente) y AnalysisWorker lo ejecuta en segundo plano. Si el servidor se
 * reinicia, el trabajo no se pierde. El frontend consulta el estado del run.
 */
export class RequestAnalysis {
  constructor(
    private readonly access: BusinessAccess,
    private readonly reviews: ReviewRepository,
    private readonly analyses: AnalysisRepository,
    private readonly analyzer: ReviewAnalyzer,
    private readonly queue: JobQueue,
  ) {}

  async execute(businessId: string, userId: string): Promise<AnalysisRun> {
    await this.access.requireOwned(businessId, userId);

    const total = await this.reviews.countByBusiness(businessId);
    if (total === 0) {
      throw new ConflictError('Primero carga algunas reseñas para poder analizarlas');
    }

    const latest = await this.analyses.findLatest(businessId);
    if (latest?.isInProgress) {
      throw new ConflictError('Ya hay un análisis en curso para este negocio');
    }

    const run = AnalysisRun.request({
      businessId,
      provider: this.analyzer.providerName,
      reviewCount: Math.min(total, MAX_REVIEWS_PER_ANALYSIS),
    });
    await this.analyses.save(run);

    // El análisis ya quedó en la cola persistente; solo se avisa al worker para que empiece ya.
    this.queue.wake();
    return run;
  }
}
