import { AnalysisRun, type AnalysisStatus } from '../../../domain/entities/AnalysisRun.js';
import type { InsightReport, Recommendation, RecommendationPriority, TopicStat } from '../../../domain/model/Insight.js';
import type { AnalysisRepository, AnalysisResults } from '../../../domain/ports/Repositories.js';
import type { Database } from '../Database.js';

interface RunRow {
  id: string;
  business_id: string;
  status: AnalysisStatus;
  provider: string;
  review_count: number;
  positive_count: number | null;
  neutral_count: number | null;
  negative_count: number | null;
  average_score: number | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface TopicRow {
  id: string;
  key: string;
  name: string;
  description: string;
  mentions: number;
  share: number;
  positive_count: number;
  neutral_count: number;
  negative_count: number;
  complaint_share: number;
  sample_quotes: string[];
}

interface RecommendationRow {
  rank: number;
  title: string;
  detail: string;
  priority: RecommendationPriority;
  evidence_share: number | null;
  topic_key: string | null;
}

export class PgAnalysisRepository implements AnalysisRepository {
  constructor(private readonly db: Database) {}

  async save(run: AnalysisRun): Promise<void> {
    await this.db.query(
      `INSERT INTO analysis_runs (id, business_id, status, provider, review_count, error, created_at, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error,
         started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at`,
      [run.id, run.businessId, run.status, run.provider, run.reviewCount, run.error, run.createdAt, run.startedAt, run.finishedAt],
    );
  }

  async findById(id: string): Promise<AnalysisRun | null> {
    const { rows } = await this.db.query<RunRow>('SELECT * FROM analysis_runs WHERE id = $1', [id]);
    return rows[0] ? PgAnalysisRepository.toDomain(rows[0]) : null;
  }

  async findLatest(businessId: string): Promise<AnalysisRun | null> {
    const { rows } = await this.db.query<RunRow>(
      'SELECT * FROM analysis_runs WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1',
      [businessId],
    );
    return rows[0] ? PgAnalysisRepository.toDomain(rows[0]) : null;
  }

  async findLatestCompleted(businessId: string): Promise<AnalysisRun | null> {
    const { rows } = await this.db.query<RunRow>(
      `SELECT * FROM analysis_runs WHERE business_id = $1 AND status = 'completed'
       ORDER BY created_at DESC LIMIT 1`,
      [businessId],
    );
    return rows[0] ? PgAnalysisRepository.toDomain(rows[0]) : null;
  }

  async listByBusiness(businessId: string, limit: number): Promise<AnalysisRun[]> {
    const { rows } = await this.db.query<RunRow>(
      'SELECT * FROM analysis_runs WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2',
      [businessId, limit],
    );
    return rows.map(PgAnalysisRepository.toDomain);
  }

  /** Unidad de trabajo: o se guarda todo el resultado del análisis, o no se guarda nada. */
  async completeWithResults(run: AnalysisRun, results: AnalysisResults): Promise<void> {
    await this.db.transaction(async (client) => {
      const s = results.sentiment;
      await client.query(
        `UPDATE analysis_runs SET status = $2, finished_at = $3, positive_count = $4, neutral_count = $5,
                negative_count = $6, average_score = $7, review_count = $8
          WHERE id = $1`,
        [run.id, run.status, run.finishedAt, s.positive, s.neutral, s.negative, s.averageScore, results.classifications.length],
      );

      const c = results.classifications;
      await client.query(
        `INSERT INTO review_sentiments (run_id, review_id, sentiment, score)
         SELECT $1, * FROM UNNEST($2::uuid[], $3::varchar[], $4::numeric[])`,
        [run.id, c.map((x) => x.reviewId), c.map((x) => x.sentiment.label), c.map((x) => x.sentiment.score)],
      );

      const topicIds = new Map<string, string>();
      for (const t of results.topics) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO topics (run_id, key, name, description, mentions, share, positive_count, neutral_count,
                               negative_count, complaint_share, sample_quotes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [run.id, t.key, t.name, t.description, t.mentions, t.share, t.positive, t.neutral, t.negative, t.complaintShare, JSON.stringify(t.sampleQuotes)],
        );
        topicIds.set(t.key, rows[0]!.id);
      }

      const links = c.flatMap((x) => x.topicKeys.filter((k) => topicIds.has(k)).map((k) => [topicIds.get(k)!, x.reviewId] as const));
      if (links.length > 0) {
        await client.query(
          'INSERT INTO review_topics (topic_id, review_id) SELECT * FROM UNNEST($1::uuid[], $2::uuid[]) ON CONFLICT DO NOTHING',
          [links.map((l) => l[0]), links.map((l) => l[1])],
        );
      }

      for (const r of results.recommendations) {
        await client.query(
          `INSERT INTO recommendations (run_id, topic_id, rank, title, detail, priority, evidence_share)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [run.id, r.topicKey ? (topicIds.get(r.topicKey) ?? null) : null, r.rank, r.title, r.detail, r.priority, r.evidenceShare],
        );
      }
    });
  }

  async getReport(runId: string): Promise<InsightReport | null> {
    const { rows: runRows } = await this.db.query<RunRow>(
      `SELECT * FROM analysis_runs WHERE id = $1 AND status = 'completed'`,
      [runId],
    );
    const run = runRows[0];
    if (!run) return null;

    const [{ rows: topicRows }, { rows: recRows }] = await Promise.all([
      this.db.query<TopicRow>('SELECT * FROM topics WHERE run_id = $1 ORDER BY mentions DESC, negative_count DESC', [runId]),
      this.db.query<RecommendationRow>(
        `SELECT r.rank, r.title, r.detail, r.priority, r.evidence_share, t.key AS topic_key
           FROM recommendations r LEFT JOIN topics t ON t.id = r.topic_id
          WHERE r.run_id = $1 ORDER BY r.rank`,
        [runId],
      ),
    ]);

    const topics: TopicStat[] = topicRows.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      mentions: t.mentions,
      share: t.share,
      positive: t.positive_count,
      neutral: t.neutral_count,
      negative: t.negative_count,
      complaintShare: t.complaint_share,
      sampleQuotes: t.sample_quotes,
    }));

    const recommendations: Recommendation[] = recRows.map((r) => ({
      rank: r.rank,
      title: r.title,
      detail: r.detail,
      priority: r.priority,
      evidenceShare: r.evidence_share,
      topicKey: r.topic_key,
    }));

    return {
      stats: {
        totalReviews: run.review_count,
        sentiment: {
          positive: run.positive_count ?? 0,
          neutral: run.neutral_count ?? 0,
          negative: run.negative_count ?? 0,
          averageScore: run.average_score ?? 0,
        },
        topics,
      },
      recommendations,
    };
  }

  async failInterrupted(reason: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE analysis_runs SET status = 'failed', error = $1, finished_at = now()
        WHERE status IN ('pending', 'running')`,
      [reason],
    );
    return result.rowCount ?? 0;
  }

  private static toDomain(row: RunRow): AnalysisRun {
    return AnalysisRun.restore({
      id: row.id,
      businessId: row.business_id,
      status: row.status,
      provider: row.provider,
      reviewCount: row.review_count,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    });
  }
}
