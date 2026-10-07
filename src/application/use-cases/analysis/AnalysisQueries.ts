import type { AnalysisRun } from '../../../domain/entities/AnalysisRun.js';
import type { Business } from '../../../domain/entities/Business.js';
import { NotFoundError } from '../../../domain/errors/DomainError.js';
import type { InsightReport } from '../../../domain/model/Insight.js';
import type { AnalysisRepository, ReviewRepository } from '../../../domain/ports/Repositories.js';
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
}

/** Consulta (lado de lectura, estilo CQRS ligero) que arma todo lo que pinta el dashboard. */
export class GetDashboard {
  constructor(
    private readonly access: BusinessAccess,
    private readonly reviews: ReviewRepository,
    private readonly analyses: AnalysisRepository,
  ) {}

  async execute(businessId: string, userId: string): Promise<Dashboard> {
    const business = await this.access.requireOwned(businessId, userId);
    const [reviewCount, latestRun, reportRun, history] = await Promise.all([
      this.reviews.countByBusiness(businessId),
      this.analyses.findLatest(businessId),
      this.analyses.findLatestCompleted(businessId),
      this.analyses.listByBusiness(businessId, 5),
    ]);
    const report = reportRun ? await this.analyses.getReport(reportRun.id) : null;
    return { business, reviewCount, latestRun, reportRun, report, history };
  }
}
