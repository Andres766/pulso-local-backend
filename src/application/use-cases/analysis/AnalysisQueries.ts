import type { AnalysisRun, AnalysisStatus } from '../../../domain/entities/AnalysisRun.js';
import type { Business } from '../../../domain/entities/Business.js';
import { NotFoundError } from '../../../domain/errors/DomainError.js';
import type { InsightReport } from '../../../domain/model/Insight.js';
import type { AnalysisRepository, BusinessRepository, ReviewRepository } from '../../../domain/ports/Repositories.js';
import type { InsightComparator, InsightComparison } from '../../../domain/services/InsightComparator.js';
import type { MonthlySentiment, SentimentTrend } from '../../../domain/services/SentimentTrend.js';
import type { BusinessAccess } from '../businesses/BusinessAccess.js';

export class GetAnalysis {
  constructor(
    private readonly access: BusinessAccess,
    private readonly analyses: AnalysisRepository,
  ) {}

  async execute(runId: string, userId: string): Promise<AnalysisRun> {
    const run = await this.analyses.findById(runId);
    if (!run) throw new NotFoundError('Análisis no encontrado');
    await this.access.requireOwned(run.businessId, userId);
    return run;
  }
}

export interface Dashboard {
  business: Business;
  reviewCount: number;
  latestRun: AnalysisRun | null;
  reportRun: AnalysisRun | null;
  report: InsightReport | null;
  history: AnalysisRun[];
  /** Análisis completado anterior al actual (base de la comparación). */
  previousRun: AnalysisRun | null;
  comparison: InsightComparison | null;
}

/** Consulta (lado de lectura, estilo CQRS ligero) que arma todo lo que pinta el dashboard. */
export class GetDashboard {
  constructor(
    private readonly access: BusinessAccess,
    private readonly reviews: ReviewRepository,
    private readonly analyses: AnalysisRepository,
    private readonly comparator: InsightComparator,
  ) {}

  async execute(businessId: string, userId: string): Promise<Dashboard> {
    const business = await this.access.requireOwned(businessId, userId);
    const [reviewCount, latestRun, completed, history] = await Promise.all([
      this.reviews.countByBusiness(businessId),
      this.analyses.findLatest(businessId),
      this.analyses.listCompleted(businessId, 2),
      this.analyses.listByBusiness(businessId, 8),
    ]);
    const reportRun = completed[0] ?? null;
    const previousRun = completed[1] ?? null;

    const [report, previousReport] = await Promise.all([
      reportRun ? this.analyses.getReport(reportRun.id) : null,
      previousRun ? this.analyses.getReport(previousRun.id) : null,
    ]);
    const comparison = report && previousReport ? this.comparator.compare(report, previousReport) : null;

    return { business, reviewCount, latestRun, reportRun, report, history, previousRun, comparison };
  }
}

/** Pulso de un negocio: lo mínimo para compararlo con los demás en "Mis negocios". */
export interface BusinessPulse {
  business: Business;
  reviewCount: number;
  /** Estado del análisis más reciente (para mostrar "Analizando…" en la lista). */
  latestStatus: AnalysisStatus | null;
  analyzedAt: Date | null;
  analyzedReviews: number;
  sentiment: InsightReport['stats']['sentiment'] | null;
  topComplaint: { key: string; name: string; complaintShare: number } | null;
  /** Variación de reseñas positivas frente al análisis anterior, en puntos porcentuales. */
  positiveShareDelta: number | null;
}

/** Resumen de todos los negocios del dueño, con el resultado de su último análisis. */
export class GetBusinessesOverview {
  constructor(
    private readonly businesses: BusinessRepository,
    private readonly reviews: ReviewRepository,
    private readonly analyses: AnalysisRepository,
    private readonly comparator: InsightComparator,
  ) {}

  async execute(ownerId: string): Promise<BusinessPulse[]> {
    const owned = await this.businesses.listByOwner(ownerId);
    return Promise.all(owned.map((business) => this.pulseOf(business)));
  }

  private async pulseOf(business: Business): Promise<BusinessPulse> {
    const [reviewCount, latestRun, completed] = await Promise.all([
      this.reviews.countByBusiness(business.id),
      this.analyses.findLatest(business.id),
      this.analyses.listCompleted(business.id, 2),
    ]);
    const [report, previousReport] = await Promise.all(completed.map((run) => this.analyses.getReport(run.id)));
    const stats = report?.stats ?? null;
    const top = stats ? [...stats.topics].sort((a, b) => b.complaintShare - a.complaintShare)[0] : undefined;

    return {
      business,
      reviewCount,
      latestStatus: latestRun?.status ?? null,
      analyzedAt: completed[0]?.finishedAt ?? null,
      analyzedReviews: stats?.totalReviews ?? 0,
      sentiment: stats?.sentiment ?? null,
      topComplaint: top && top.complaintShare > 0 ? { key: top.key, name: top.name, complaintShare: top.complaintShare } : null,
      positiveShareDelta: report && previousReport ? this.comparator.compare(report, previousReport).positiveShareDelta : null,
    };
  }
}

export const TREND_MAX_MONTHS = 24;

/** Serie mensual del sentimiento según el último análisis completado. */
export class GetSentimentTrend {
  constructor(
    private readonly access: BusinessAccess,
    private readonly analyses: AnalysisRepository,
    private readonly trend: SentimentTrend,
  ) {}

  async execute(businessId: string, userId: string, months: number): Promise<{ runId: string | null; points: MonthlySentiment[] }> {
    await this.access.requireOwned(businessId, userId);
    const run = await this.analyses.findLatestCompleted(businessId);
    if (!run) return { runId: null, points: [] };
    const points = await this.analyses.sentimentByMonth(run.id, Math.min(Math.max(months, 1), TREND_MAX_MONTHS));
    return { runId: run.id, points: this.trend.fillGaps(points) };
  }
}
