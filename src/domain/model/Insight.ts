import type { SentimentLabel } from '../value-objects/Sentiment.js';
import { Sentiment } from '../value-objects/Sentiment.js';

/**
 * Tipos del "lenguaje ubicuo" del análisis. La IA produce clasificaciones y borradores;
 * las cifras (conteos y porcentajes) SIEMPRE las calcula el código, nunca el LLM,
 * para que ninguna recomendación cite un porcentaje inventado.
 */

/** Tema recurrente detectado en las reseñas (resultado del topic modeling). */
export interface TopicDefinition {
  /** Identificador estable en snake_case, p. ej. "tiempo_entrega". */
  key: string;
  /** Nombre legible, p. ej. "Tiempo de entrega". */
  name: string;
  description: string;
}

/** Lo que la IA concluye sobre UNA reseña. */
export interface ReviewClassification {
  reviewId: string;
  sentiment: Sentiment;
  topicKeys: string[];
}

export const RECOMMENDATION_PRIORITIES = ['alta', 'media', 'baja'] as const;
export type RecommendationPriority = (typeof RECOMMENDATION_PRIORITIES)[number];

/** Recomendación tal como la redacta el proveedor de IA (antes de enriquecerla con cifras). */
export interface RecommendationDraft {
  title: string;
  detail: string;
  priority: RecommendationPriority;
  topicKey: string | null;
}

export interface SentimentBreakdown {
  positive: number;
  neutral: number;
  negative: number;
  /** Promedio del puntaje continuo en [-1, 1]. */
  averageScore: number;
}

export interface TopicStat extends TopicDefinition {
  mentions: number;
  /** Porcentaje de reseñas que mencionan el tema (0-100). */
  share: number;
  positive: number;
  neutral: number;
  negative: number;
  /** Porcentaje del TOTAL de reseñas que se quejan de este tema (0-100). */
  complaintShare: number;
  sampleQuotes: string[];
}

export interface InsightStats {
  totalReviews: number;
  sentiment: SentimentBreakdown;
  topics: TopicStat[];
}

export interface Recommendation extends RecommendationDraft {
  rank: number;
  /** Porcentaje de reseñas negativas sobre el tema que respalda la recomendación. */
  evidenceShare: number | null;
}

/** Resultado completo que consume el dashboard. */
export interface InsightReport {
  stats: InsightStats;
  recommendations: Recommendation[];
}

export interface ReviewText {
  id: string;
  content: string;
  rating: number | null;
}

export interface BusinessContext {
  name: string;
  category: string;
  city: string | null;
}

export type { SentimentLabel };
