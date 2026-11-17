import type { AnalysisRun } from '../entities/AnalysisRun.js';
import type { Business } from '../entities/Business.js';
import type { Review } from '../entities/Review.js';
import type { User } from '../entities/User.js';
import type { InsightReport, Recommendation, ReviewClassification, TopicStat } from '../model/Insight.js';
import type { MonthlySentiment } from '../services/SentimentTrend.js';
import type { Email } from '../value-objects/Email.js';
import type { SentimentLabel } from '../value-objects/Sentiment.js';

/**
 * Puertos de persistencia (patrón Repository). El dominio define QUÉ necesita;
 * la infraestructura (PostgreSQL) decide CÓMO. En los tests se reemplazan por
 * implementaciones en memoria.
 */

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  save(user: User): Promise<void>;
  /** Borra la cuenta y, en cascada, sus negocios, reseñas y análisis. */
  delete(id: string): Promise<void>;
}

export interface BusinessRepository {
  findById(id: string): Promise<Business | null>;
  listByOwner(ownerId: string): Promise<Business[]>;
  save(business: Business): Promise<void>;
  delete(id: string): Promise<void>;
}

export const REVIEW_SORTS = ['recent', 'oldest', 'rating_desc', 'rating_asc', 'most_negative', 'most_positive'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export interface ReviewFilter {
  sentiment?: SentimentLabel;
  topicKey?: string;
  search?: string;
  /** Calificación exacta en estrellas (1-5). */
  rating?: number;
  sort?: ReviewSort;
  limit: number;
  offset: number;
}

/** Fila de lectura para el dashboard: la reseña más lo que dijo el último análisis. */
export interface ReviewWithInsight {
  review: Review;
  sentiment: SentimentLabel | null;
  sentimentScore: number | null;
  topics: string[];
}

export interface ReviewRepository {
  /** Inserta ignorando duplicados (misma huella en el mismo negocio). Devuelve cuántas se insertaron. */
  saveMany(reviews: readonly Review[]): Promise<number>;
  countByBusiness(businessId: string): Promise<number>;
  /** Reseñas más recientes primero, hasta `limit`, para alimentar el análisis. */
  listForAnalysis(businessId: string, limit: number): Promise<Review[]>;
  search(businessId: string, filter: ReviewFilter): Promise<{ items: ReviewWithInsight[]; total: number }>;
  /** Borra una reseña solo si pertenece a ese negocio. Devuelve false si no existía allí. */
  deleteOne(businessId: string, reviewId: string): Promise<boolean>;
  deleteAll(businessId: string): Promise<number>;
}

export interface AnalysisResults {
  classifications: readonly ReviewClassification[];
  topics: readonly TopicStat[];
  recommendations: readonly Recommendation[];
  sentiment: InsightReport['stats']['sentiment'];
}

export interface AnalysisRepository {
  save(run: AnalysisRun): Promise<void>;
  findById(id: string): Promise<AnalysisRun | null>;
  findLatest(businessId: string): Promise<AnalysisRun | null>;
  findLatestCompleted(businessId: string): Promise<AnalysisRun | null>;
  /** Análisis completados, del más reciente al más antiguo. */
  listCompleted(businessId: string, limit: number): Promise<AnalysisRun[]>;
  listByBusiness(businessId: string, limit: number): Promise<AnalysisRun[]>;
  /** Guarda el run completado y todos sus resultados en UNA transacción. */
  completeWithResults(run: AnalysisRun, results: AnalysisResults): Promise<void>;
  getReport(runId: string): Promise<InsightReport | null>;
  /** Conteo por mes de escritura de la reseña, según el sentimiento que asignó ese análisis. */
  sentimentByMonth(runId: string, months: number): Promise<MonthlySentiment[]>;
  /**
   * Toma de forma atómica el siguiente análisis pendiente y listo (available_at <= ahora),
   * lo pasa a "running" y lo devuelve. Dos workers nunca obtienen el mismo análisis.
   */
  claimNext(): Promise<AnalysisRun | null>;
  /**
   * Al arrancar: los análisis que quedaron "running" por un reinicio vuelven a la cola si les
   * quedan intentos; si no, se marcan como fallidos con `reason`.
   */
  recoverInterrupted(reason: string): Promise<{ requeued: number; failed: number }>;
}

/** Cifras de toda la plataforma para el panel de administración. Solo agregados: nada de contenido. */
export interface PlatformOverview {
  users: number;
  admins: number;
  lockedUsers: number;
  businesses: number;
  reviews: number;
  analyses: { completed: number; failed: number; inProgress: number };
  llm: { calls: number; inputTokens: number; outputTokens: number };
}

export interface DailyUsage {
  /** Día en formato AAAA-MM-DD (UTC). */
  day: string;
  analyses: number;
  failed: number;
  llmCalls: number;
  tokens: number;
}

/** Fila de la lista de usuarios: datos de la cuenta y conteos, nunca reseñas ni análisis ajenos. */
export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  createdAt: Date;
  lockedUntil: Date | null;
  businesses: number;
  reviews: number;
}

export interface FailedAnalysis {
  runId: string;
  businessId: string;
  businessName: string;
  ownerEmail: string;
  provider: string;
  attempts: number;
  error: string | null;
  finishedAt: Date | null;
}

/**
 * Modelo de lectura del panel de administración (CQRS ligero): consultas agregadas sobre toda la
 * plataforma, separadas de los repositorios que usan los casos de uso del dueño del negocio.
 */
export interface AdminReadModel {
  overview(now: Date): Promise<PlatformOverview>;
  usageByDay(days: number): Promise<DailyUsage[]>;
  listUsers(limit: number): Promise<UserSummary[]>;
  failedAnalyses(limit: number): Promise<FailedAnalysis[]>;
}
