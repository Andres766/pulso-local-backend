import type { Request, Response } from 'express';
import type {
  GetAnalysis,
  GetBusinessesOverview,
  GetDashboard,
  GetSentimentTrend,
} from '../../../application/use-cases/analysis/AnalysisQueries.js';
import type { RequestAnalysis } from '../../../application/use-cases/analysis/RequestAnalysis.js';
import { trendQuery, uuidParam } from '../schemas.js';

export class AnalysisController {
  constructor(
    private readonly requestAnalysis: RequestAnalysis,
    private readonly getAnalysis: GetAnalysis,
    private readonly getDashboard: GetDashboard,
    private readonly getSentimentTrend: GetSentimentTrend,
    private readonly getOverview: GetBusinessesOverview,
  ) {}

  /** 202 Accepted: el análisis corre en segundo plano; el cliente consulta GET /analyses/:id. */
  start = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const run = await this.requestAnalysis.execute(id, req.userId!);
    res.status(202).location(`/api/analyses/${run.id}`).json(run.toJSON());
  };

  status = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    res.json((await this.getAnalysis.execute(id, req.userId!)).toJSON());
  };

  dashboard = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const d = await this.getDashboard.execute(id, req.userId!);
    res.json({
      business: d.business.toJSON(),
      reviewCount: d.reviewCount,
      latestRun: d.latestRun?.toJSON() ?? null,
      reportRun: d.reportRun?.toJSON() ?? null,
      report: d.report,
      history: d.history.map((r) => r.toJSON()),
      previousRun: d.previousRun?.toJSON() ?? null,
      comparison: d.comparison,
    });
  };

  overview = async (req: Request, res: Response) => {
    const items = await this.getOverview.execute(req.userId!);
    res.json({
      items: items.map((p) => ({
        business: p.business.toJSON(),
        reviewCount: p.reviewCount,
        latestStatus: p.latestStatus,
        analyzedAt: p.analyzedAt?.toISOString() ?? null,
        analyzedReviews: p.analyzedReviews,
        sentiment: p.sentiment,
        topComplaint: p.topComplaint,
        positiveShareDelta: p.positiveShareDelta,
      })),
    });
  };

  trend = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const { months } = trendQuery.parse(req.query);
    res.json(await this.getSentimentTrend.execute(id, req.userId!, months));
  };
}
