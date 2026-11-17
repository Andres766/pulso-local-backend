import type { AdminReadModel, DailyUsage, FailedAnalysis, PlatformOverview, UserSummary } from '../../../domain/ports/Repositories.js';
import type { Database } from '../Database.js';

/**
 * Consultas agregadas del panel de administración. Solo devuelve conteos, consumo y metadatos
 * (correo del dueño, nombre del negocio, error): nunca el texto de las reseñas ni los resultados
 * de los análisis de otros usuarios. Todas las consultas son parametrizadas.
 */
export class PgAdminReadModel implements AdminReadModel {
  constructor(private readonly db: Database) {}

  async overview(now: Date): Promise<PlatformOverview> {
    const { rows } = await this.db.query<Record<string, number>>(
      `SELECT
         (SELECT count(*) FROM users)::int                                          AS users,
         (SELECT count(*) FROM users WHERE role = 'admin')::int                     AS admins,
         (SELECT count(*) FROM users WHERE locked_until > $1)::int                  AS locked_users,
         (SELECT count(*) FROM businesses)::int                                     AS businesses,
         (SELECT count(*) FROM reviews)::int                                        AS reviews,
         (SELECT count(*) FROM analysis_runs WHERE status = 'completed')::int       AS completed,
         (SELECT count(*) FROM analysis_runs WHERE status = 'failed')::int          AS failed,
         (SELECT count(*) FROM analysis_runs WHERE status IN ('pending', 'running'))::int AS in_progress,
         (SELECT coalesce(sum(llm_calls), 0) FROM analysis_runs)::int               AS calls,
         (SELECT coalesce(sum(input_tokens), 0) FROM analysis_runs)::int            AS input_tokens,
         (SELECT coalesce(sum(output_tokens), 0) FROM analysis_runs)::int           AS output_tokens`,
      [now],
    );
    const r = rows[0]!;
    return {
      users: r.users!,
      admins: r.admins!,
      lockedUsers: r.locked_users!,
      businesses: r.businesses!,
      reviews: r.reviews!,
      analyses: { completed: r.completed!, failed: r.failed!, inProgress: r.in_progress! },
      llm: { calls: r.calls!, inputTokens: r.input_tokens!, outputTokens: r.output_tokens! },
    };
  }

  /** Un punto por día (también los días sin análisis, en cero) para dibujar la serie sin huecos. */
  async usageByDay(days: number): Promise<DailyUsage[]> {
    const { rows } = await this.db.query<{ day: string; analyses: number; failed: number; llm_calls: number; tokens: number }>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              count(r.id)::int                                     AS analyses,
              count(r.id) FILTER (WHERE r.status = 'failed')::int  AS failed,
              coalesce(sum(r.llm_calls), 0)::int                   AS llm_calls,
              coalesce(sum(r.input_tokens + r.output_tokens), 0)::int AS tokens
         FROM generate_series((now() AT TIME ZONE 'UTC')::date - ($1::int - 1), (now() AT TIME ZONE 'UTC')::date, interval '1 day') AS d(day)
         LEFT JOIN analysis_runs r ON (r.created_at AT TIME ZONE 'UTC')::date = d.day::date
        GROUP BY d.day
        ORDER BY d.day`,
      [days],
    );
    return rows.map((r) => ({ day: r.day, analyses: r.analyses, failed: r.failed, llmCalls: r.llm_calls, tokens: r.tokens }));
  }

  async listUsers(limit: number): Promise<UserSummary[]> {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      email: string;
      role: 'user' | 'admin';
      created_at: Date;
      locked_until: Date | null;
      businesses: number;
      reviews: number;
    }>(
      `SELECT u.id, u.name, u.email, u.role, u.created_at, u.locked_until,
              (SELECT count(*) FROM businesses b WHERE b.owner_id = u.id)::int AS businesses,
              (SELECT count(*) FROM reviews r JOIN businesses b ON b.id = r.business_id WHERE b.owner_id = u.id)::int AS reviews
         FROM users u
        ORDER BY u.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
      lockedUntil: r.locked_until,
      businesses: r.businesses,
      reviews: r.reviews,
    }));
  }

  async failedAnalyses(limit: number): Promise<FailedAnalysis[]> {
    const { rows } = await this.db.query<{
      id: string;
      business_id: string;
      business_name: string;
      owner_email: string;
      provider: string;
      attempts: number;
      error: string | null;
      finished_at: Date | null;
    }>(
      `SELECT r.id, r.business_id, b.name AS business_name, u.email AS owner_email,
              r.provider, r.attempts, r.error, r.finished_at
         FROM analysis_runs r
         JOIN businesses b ON b.id = r.business_id
         JOIN users u ON u.id = b.owner_id
        WHERE r.status = 'failed'
        ORDER BY r.finished_at DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      runId: r.id,
      businessId: r.business_id,
      businessName: r.business_name,
      ownerEmail: r.owner_email,
      provider: r.provider,
      attempts: r.attempts,
      error: r.error,
      finishedAt: r.finished_at,
    }));
  }
}
