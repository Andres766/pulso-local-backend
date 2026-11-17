import type { AnalysisRun } from '../src/domain/entities/AnalysisRun.js';
import type { Business } from '../src/domain/entities/Business.js';
import type { Review } from '../src/domain/entities/Review.js';
import type { User } from '../src/domain/entities/User.js';
import type { InsightReport } from '../src/domain/model/Insight.js';
import type {
  AdminReadModel,
  AnalysisRepository,
  AnalysisResults,
  BusinessRepository,
  DailyUsage,
  FailedAnalysis,
  PlatformOverview,
  ReviewFilter,
  ReviewRepository,
  ReviewWithInsight,
  UserRepository,
  UserSummary,
} from '../src/domain/ports/Repositories.js';
import type { JobQueue, Logger, PasswordHasher, TokenPayload, TokenService } from '../src/domain/ports/Services.js';
import type { MonthlySentiment } from '../src/domain/services/SentimentTrend.js';
import type { Email } from '../src/domain/value-objects/Email.js';

/** Implementaciones en memoria de los puertos: los casos de uso se prueban sin base de datos. */

export class InMemoryUsers implements UserRepository {
  readonly items = new Map<string, User>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEmail(email: Email) {
    return [...this.items.values()].find((u) => u.email.equals(email)) ?? null;
  }
  async save(user: User) {
    this.items.set(user.id, user);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryBusinesses implements BusinessRepository {
  readonly items = new Map<string, Business>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async listByOwner(ownerId: string) {
    return [...this.items.values()].filter((b) => b.ownerId === ownerId);
  }
  async save(b: Business) {
    this.items.set(b.id, b);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryReviews implements ReviewRepository {
  readonly items: Review[] = [];
  async saveMany(reviews: readonly Review[]) {
    let n = 0;
    for (const r of reviews) {
      if (this.items.some((x) => x.businessId === r.businessId && x.contentHash === r.contentHash)) continue;
      this.items.push(r);
      n++;
    }
    return n;
  }
  async countByBusiness(id: string) {
    return this.items.filter((r) => r.businessId === id).length;
  }
  async listForAnalysis(id: string, limit: number) {
    return this.items.filter((r) => r.businessId === id).slice(0, limit);
  }
  async search(id: string, f: ReviewFilter): Promise<{ items: ReviewWithInsight[]; total: number }> {
    const rating = (r: Review) => r.rating?.value ?? 0;
    const all = this.items.filter((r) => r.businessId === id && (!f.rating || rating(r) === f.rating));
    if (f.sort === 'rating_desc') all.sort((a, b) => rating(b) - rating(a));
    if (f.sort === 'rating_asc') all.sort((a, b) => rating(a) - rating(b));
    return {
      total: all.length,
      items: all.slice(f.offset, f.offset + f.limit).map((review) => ({ review, sentiment: null, sentimentScore: null, topics: [] })),
    };
  }
  async deleteOne(businessId: string, reviewId: string) {
    const i = this.items.findIndex((r) => r.id === reviewId && r.businessId === businessId);
    if (i === -1) return false;
    this.items.splice(i, 1);
    return true;
  }
  async deleteAll(id: string) {
    const before = this.items.length;
    this.items.splice(0, this.items.length, ...this.items.filter((r) => r.businessId !== id));
    return before - this.items.length;
  }
}

export class InMemoryAnalyses implements AnalysisRepository {
  readonly runs = new Map<string, AnalysisRun>();
  readonly results = new Map<string, AnalysisResults>();
  /** Opcional: permite calcular la tendencia mensual con las fechas de las reseñas. */
  constructor(private readonly reviews?: InMemoryReviews) {}
  async save(run: AnalysisRun) {
    this.runs.set(run.id, run);
  }
  async findById(id: string) {
    return this.runs.get(id) ?? null;
  }
  private byBusiness(id: string) {
    return [...this.runs.values()].filter((r) => r.businessId === id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async findLatest(id: string) {
    return this.byBusiness(id)[0] ?? null;
  }
  async findLatestCompleted(id: string) {
    return this.byBusiness(id).find((r) => r.status === 'completed') ?? null;
  }
  async listCompleted(id: string, limit: number) {
    return this.byBusiness(id)
      .filter((r) => r.status === 'completed')
      .slice(0, limit);
  }
  async listByBusiness(id: string, limit: number) {
    return this.byBusiness(id).slice(0, limit);
  }
  async completeWithResults(run: AnalysisRun, results: AnalysisResults) {
    this.runs.set(run.id, run);
    this.results.set(run.id, results);
  }
  async getReport(runId: string): Promise<InsightReport | null> {
    const r = this.results.get(runId);
    if (!r) return null;
    return {
      stats: { totalReviews: r.classifications.length, sentiment: r.sentiment, topics: [...r.topics] },
      recommendations: [...r.recommendations],
    };
  }
  async sentimentByMonth(runId: string): Promise<MonthlySentiment[]> {
    const byMonth = new Map<string, MonthlySentiment>();
    for (const c of this.results.get(runId)?.classifications ?? []) {
      const review = this.reviews?.items.find((r) => r.id === c.reviewId);
      if (!review) continue;
      const month = (review.authoredAt ?? review.createdAt).toISOString().slice(0, 7);
      const p = byMonth.get(month) ?? { month, positive: 0, neutral: 0, negative: 0, total: 0, averageScore: null };
      p[c.sentiment.label] += 1;
      p.total += 1;
      byMonth.set(month, p);
    }
    return [...byMonth.values()];
  }
  async claimNext() {
    const now = Date.now();
    const next = [...this.runs.values()]
      .filter((r) => r.status === 'pending' && r.availableAt.getTime() <= now)
      .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!next) return null;
    next.start();
    return next;
  }
  async recoverInterrupted(reason: string) {
    let requeued = 0;
    let failed = 0;
    for (const r of this.runs.values()) {
      if (r.status !== 'running') continue;
      if (r.canRetry) {
        r.retryLater(reason, 0);
        requeued++;
      } else {
        r.fail(reason);
        failed++;
      }
    }
    return { requeued, failed };
  }
}

/** Hasher trivial para tests (bcrypt real haría los tests lentos). */
export class FakeHasher implements PasswordHasher {
  async hash(plain: string) {
    return `hashed:${plain}`;
  }
  async verify(plain: string, hash: string) {
    return hash === `hashed:${plain}`;
  }
}

export class FakeTokens implements TokenService {
  sign(p: TokenPayload) {
    return `token:${p.sub}:${p.ver}`;
  }
  verify(t: string) {
    const [kind, sub, ver] = t.split(':');
    return kind === 'token' && sub ? { sub, email: 'x@y.co', ver: Number(ver ?? 0) } : null;
  }
}

/** Cola de prueba: registra los avisos; el test decide cuándo vaciar la cola con el worker. */
export class ManualQueue implements JobQueue {
  wakes = 0;
  wake() {
    this.wakes++;
  }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Panel de administración sobre los repositorios en memoria (mismas reglas que PgAdminReadModel). */
export class InMemoryAdminReadModel implements AdminReadModel {
  constructor(
    private readonly users: InMemoryUsers,
    private readonly businesses: InMemoryBusinesses,
    private readonly reviews: InMemoryReviews,
    private readonly analyses: InMemoryAnalyses,
  ) {}

  private get runs() {
    return [...this.analyses.runs.values()];
  }

  async overview(now: Date): Promise<PlatformOverview> {
    const users = [...this.users.items.values()];
    const sum = (pick: (u: { calls: number; inputTokens: number; outputTokens: number }) => number) =>
      this.runs.reduce((n, r) => n + pick(r.usage), 0);
    return {
      users: users.length,
      admins: users.filter((u) => u.isAdmin).length,
      lockedUsers: users.filter((u) => u.isLocked(now)).length,
      businesses: this.businesses.items.size,
      reviews: this.reviews.items.length,
      analyses: {
        completed: this.runs.filter((r) => r.status === 'completed').length,
        failed: this.runs.filter((r) => r.status === 'failed').length,
        inProgress: this.runs.filter((r) => r.isInProgress).length,
      },
      llm: { calls: sum((u) => u.calls), inputTokens: sum((u) => u.inputTokens), outputTokens: sum((u) => u.outputTokens) },
    };
  }

  async usageByDay(days: number): Promise<DailyUsage[]> {
    const today = new Date();
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1 - i)));
      const day = d.toISOString().slice(0, 10);
      const runs = this.runs.filter((r) => r.createdAt.toISOString().slice(0, 10) === day);
      return {
        day,
        analyses: runs.length,
        failed: runs.filter((r) => r.status === 'failed').length,
        llmCalls: runs.reduce((n, r) => n + r.usage.calls, 0),
        tokens: runs.reduce((n, r) => n + r.usage.inputTokens + r.usage.outputTokens, 0),
      };
    });
  }

  async listUsers(limit: number): Promise<UserSummary[]> {
    return [...this.users.items.values()].slice(0, limit).map((u) => {
      const owned = [...this.businesses.items.values()].filter((b) => b.ownerId === u.id).map((b) => b.id);
      return {
        id: u.id,
        name: u.name,
        email: u.email.value,
        role: u.role,
        createdAt: u.createdAt,
        lockedUntil: u.lockedUntil,
        businesses: owned.length,
        reviews: this.reviews.items.filter((r) => owned.includes(r.businessId)).length,
      };
    });
  }

  async failedAnalyses(limit: number): Promise<FailedAnalysis[]> {
    return this.runs
      .filter((r) => r.status === 'failed')
      .slice(0, limit)
      .map((r) => {
        const business = this.businesses.items.get(r.businessId);
        const owner = business ? this.users.items.get(business.ownerId) : undefined;
        return {
          runId: r.id,
          businessId: r.businessId,
          businessName: business?.name ?? '',
          ownerEmail: owner?.email.value ?? '',
          provider: r.provider,
          attempts: r.attempts,
          error: r.error,
          finishedAt: r.finishedAt,
        };
      });
  }
}
