import type { AnalysisRun } from '../../domain/entities/AnalysisRun.js';
import type { InsightReport } from '../../domain/model/Insight.js';
import type { AnalysisRepository, AnalysisResults } from '../../domain/ports/Repositories.js';
import type { AnalysisEventPublisher } from '../../domain/ports/Services.js';
import type { MonthlySentiment } from '../../domain/services/SentimentTrend.js';

/**
 * Decorador (patrón Decorator) del repositorio de análisis: delega todo en el repositorio real y,
 * cada vez que un análisis cambia de estado y queda guardado, publica el evento. Así los casos de
 * uso (RequestAnalysis, ExecuteAnalysis, AnalysisWorker) no saben que existe el tiempo real.
 */
export class PublishingAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly inner: AnalysisRepository,
    private readonly events: AnalysisEventPublisher,
  ) {}

  private announce(run: AnalysisRun): void {
    this.events.publish({ businessId: run.businessId, run: run.toJSON() });
  }

  async save(run: AnalysisRun): Promise<void> {
    await this.inner.save(run);
    this.announce(run);
  }

  async completeWithResults(run: AnalysisRun, results: AnalysisResults): Promise<void> {
    await this.inner.completeWithResults(run, results);
    this.announce(run);
  }

  /** Tomar un análisis de la cola lo pasa a "running": también es un cambio de estado. */
  async claimNext(): Promise<AnalysisRun | null> {
    const run = await this.inner.claimNext();
    if (run) this.announce(run);
    return run;
  }

  findById(id: string): Promise<AnalysisRun | null> {
    return this.inner.findById(id);
  }
  findLatest(businessId: string): Promise<AnalysisRun | null> {
    return this.inner.findLatest(businessId);
  }
  findLatestCompleted(businessId: string): Promise<AnalysisRun | null> {
    return this.inner.findLatestCompleted(businessId);
  }
  listCompleted(businessId: string, limit: number): Promise<AnalysisRun[]> {
    return this.inner.listCompleted(businessId, limit);
  }
  listByBusiness(businessId: string, limit: number): Promise<AnalysisRun[]> {
    return this.inner.listByBusiness(businessId, limit);
  }
  getReport(runId: string): Promise<InsightReport | null> {
    return this.inner.getReport(runId);
  }
  sentimentByMonth(runId: string, months: number): Promise<MonthlySentiment[]> {
    return this.inner.sentimentByMonth(runId, months);
  }
  recoverInterrupted(reason: string): Promise<{ requeued: number; failed: number }> {
    return this.inner.recoverInterrupted(reason);
  }
}
