import { z } from 'zod';
import {
  RECOMMENDATION_PRIORITIES,
  type BusinessContext,
  type InsightStats,
  type RecommendationDraft,
  type ReviewClassification,
  type ReviewText,
  type TopicDefinition,
} from '../../domain/model/Insight.js';
import type { ReviewAnalyzer } from '../../domain/ports/ReviewAnalyzer.js';
import { SENTIMENT_LABELS, Sentiment } from '../../domain/value-objects/Sentiment.js';
import { classificationPrompt, recommendationPrompt, topicDiscoveryPrompt } from './prompts.js';

// Esquemas de salida estructurada, iguales para cualquier LLM: el proveedor restringe la respuesta
// a esta forma y además se valida con Zod al recibirla (defensa en profundidad).
export const TopicsOutput = z.object({
  topics: z.array(z.object({ key: z.string(), name: z.string(), description: z.string() })),
});

export const ClassificationOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      sentiment: z.enum(SENTIMENT_LABELS),
      score: z.number(),
      topics: z.array(z.string()),
    }),
  ),
});

export const RecommendationsOutput = z.object({
  recommendations: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      priority: z.enum(RECOMMENDATION_PRIORITIES),
      topic_key: z.string().nullable(),
    }),
  ),
});

/** Cuánto debe "pensar" el modelo en cada paso: poco para clasificar en volumen, más para recomendar. */
export type Effort = 'low' | 'medium' | 'high';

/**
 * Patrón Template Method: esta clase define el algoritmo común a todos los proveedores de LLM
 * (armar prompts, usar alias cortos en lugar de UUID, traducir la salida al dominio) y deja
 * abstracto un único paso, `generate`, que cada proveedor implementa con su propia API.
 *
 *   ReviewAnalyzer (puerto)
 *        ▲
 *   LlmReviewAnalyzer (abstracta)  ◄── HeuristicReviewAnalyzer implementa el puerto directamente
 *        ▲               ▲
 *   ClaudeReviewAnalyzer  GeminiReviewAnalyzer
 */
export abstract class LlmReviewAnalyzer implements ReviewAnalyzer {
  readonly batchSize = 40;
  abstract readonly providerName: string;

  /** Llama al modelo y devuelve la salida YA validada contra `schema`; lanza AnalyzerError si falla. */
  protected abstract generate<T extends z.ZodType>(prompt: string, schema: T, effort: Effort, step: string): Promise<z.infer<T>>;

  async discoverTopics(
    sample: readonly ReviewText[],
    context: BusinessContext,
    previousTopics: readonly TopicDefinition[] = [],
  ): Promise<TopicDefinition[]> {
    const out = await this.generate(topicDiscoveryPrompt(sample, context, previousTopics), TopicsOutput, 'medium', 'descubrir temas');
    return out.topics;
  }

  async classify(batch: readonly ReviewText[], topics: readonly TopicDefinition[]): Promise<ReviewClassification[]> {
    // Alias cortos (r1, r2…) en lugar de UUID: menos tokens y el modelo no ve IDs internos.
    const aliased = batch.map((review, i) => ({ alias: `r${i + 1}`, review }));
    const byAlias = new Map(aliased.map((a) => [a.alias, a.review.id]));

    const out = await this.generate(classificationPrompt(aliased, topics), ClassificationOutput, 'low', 'clasificar reseñas');

    return out.results.flatMap((r) => {
      const reviewId = byAlias.get(r.id);
      if (!reviewId) return [];
      return [{ reviewId, sentiment: Sentiment.of(r.sentiment, r.score), topicKeys: r.topics }];
    });
  }

  async recommend(stats: InsightStats, context: BusinessContext): Promise<RecommendationDraft[]> {
    const out = await this.generate(recommendationPrompt(stats, context), RecommendationsOutput, 'high', 'generar recomendaciones');
    return out.recommendations.slice(0, 6).map((r) => ({
      title: r.title.trim().slice(0, 120),
      detail: r.detail.trim().slice(0, 800),
      priority: r.priority,
      topicKey: r.topic_key,
    }));
  }
}
