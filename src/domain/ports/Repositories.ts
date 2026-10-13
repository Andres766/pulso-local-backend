import type { AnalysisRun } from '../entities/AnalysisRun.js';
import type { Business } from '../entities/Business.js';
import type { Review } from '../entities/Review.js';
import type { User } from '../entities/User.js';
import type { Email } from '../value-objects/Email.js';
import type { SentimentLabel } from '../value-objects/Sentiment.js';
import type { InsightReport, Recommendation, ReviewClassification, TopicStat } from '../model/Insight.js';

/**
 * Puertos de persistencia (patrón Repository). El dominio define QUÉ necesita;
 * la infraestructura (PostgreSQL) decide CÓMO. En los tests se reemplazan por
 * implementaciones en memoria.
 */

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  save(user: User): Promise<void>;
}

export interface BusinessRepository {
  findById(id: string): Promise<Business | null>;
  listByOwner(ownerId: string): Promise<Business[]>;
  save(business: Business): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReviewFilter {
  sentiment?: SentimentLabel;
  topicKey?: string;
  search?: string;
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
  /** Al arrancar: los análisis que quedaron a medias por un reinicio se marcan como fallidos. */
  failInterrupted(reason: string): Promise<number>;
}
