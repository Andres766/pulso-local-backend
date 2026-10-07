import type { AnalysisRun } from '../src/domain/entities/AnalysisRun.js';
import type { Business } from '../src/domain/entities/Business.js';
import type { Review } from '../src/domain/entities/Review.js';
import type { User } from '../src/domain/entities/User.js';
import type { InsightReport } from '../src/domain/model/Insight.js';
import type {
  AnalysisRepository,
  AnalysisResults,
  BusinessRepository,
  ReviewFilter,
  ReviewRepository,
  ReviewWithInsight,
  UserRepository,
} from '../src/domain/ports/Repositories.js';
import type { Logger, PasswordHasher, TaskScheduler, TokenPayload, TokenService } from '../src/domain/ports/Services.js';
import type { Email } from '../src/domain/value-objects/Email.js';

/** Implementaciones en memoria de los puertos: los casos de uso se prueban sin base de datos. */

export class InMemoryUsers implements UserRepository {
  readonly items = new Map<string, User>();
  async findById(id: string) { return this.items.get(id) ?? null; }
  async findByEmail(email: Email) { return [...this.items.values()].find((u) => u.email.equals(email)) ?? null; }
  async save(user: User) { this.items.set(user.id, user); }
}

export class InMemoryBusinesses implements BusinessRepository {
  readonly items = new Map<string, Business>();
  async findById(id: string) { return this.items.get(id) ?? null; }
  async listByOwner(ownerId: string) { return [...this.items.values()].filter((b) => b.ownerId === ownerId); }
  async save(b: Business) { this.items.set(b.id, b); }
  async delete(id: string) { this.items.delete(id); }
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
  async countByBusiness(id: string) { return this.items.filter((r) => r.businessId === id).length; }
  async listForAnalysis(id: string, limit: number) { return this.items.filter((r) => r.businessId === id).slice(0, limit); }
  async search(id: string, f: ReviewFilter): Promise<{ items: ReviewWithInsight[]; total: number }> {
    const all = this.items.filter((r) => r.businessId === id);
    return {
      total: all.length,
      items: all.slice(f.offset, f.offset + f.limit).map((review) => ({ review, sentiment: null, sentimentScore: null, topics: [] })),
    };
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
  async save(run: AnalysisRun) { this.runs.set(run.id, run); }
  async findById(id: string) { return this.runs.get(id) ?? null; }
  private byBusiness(id: string) {
    return [...this.runs.values()].filter((r) => r.businessId === id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async findLatest(id: string) { return this.byBusiness(id)[0] ?? null; }
  async findLatestCompleted(id: string) { return this.byBusiness(id).find((r) => r.status === 'completed') ?? null; }
  async listByBusiness(id: string, limit: number) { return this.byBusiness(id).slice(0, limit); }
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
  async failInterrupted() { return 0; }
}

/** Hasher trivial para tests (bcrypt real haría los tests lentos). */
export class FakeHasher implements PasswordHasher {
  async hash(plain: string) { return `hashed:${plain}`; }
  async verify(plain: string, hash: string) { return hash === `hashed:${plain}`; }
}

export class FakeTokens implements TokenService {
  sign(p: TokenPayload) { return `token:${p.sub}`; }
  verify(t: string) { return t.startsWith('token:') ? { sub: t.slice(6), email: 'x@y.co' } : null; }
}

/** Ejecuta las tareas en el acto y permite esperarlas desde el test. */
export class ImmediateScheduler implements TaskScheduler {
  readonly tasks: Promise<void>[] = [];
  schedule(_name: string, task: () => Promise<void>) { this.tasks.push(task()); }
  async flush() { await Promise.all(this.tasks); }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
