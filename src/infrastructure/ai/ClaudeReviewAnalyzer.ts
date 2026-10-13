import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { AnalyzerError } from '../../domain/errors/DomainError.js';
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
import type { Logger } from '../../domain/ports/Services.js';
import { SENTIMENT_LABELS, Sentiment } from '../../domain/value-objects/Sentiment.js';
import { SYSTEM_PROMPT, classificationPrompt, recommendationPrompt, topicDiscoveryPrompt } from './prompts.js';

// Esquemas de salida estructurada: la API garantiza JSON con esta forma y el SDK lo valida con Zod.
const TopicsOutput = z.object({
  topics: z.array(z.object({ key: z.string(), name: z.string(), description: z.string() })),
});

const ClassificationOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      sentiment: z.enum(SENTIMENT_LABELS),
      score: z.number(),
      topics: z.array(z.string()),
    }),
  ),
});

const RecommendationsOutput = z.object({
  recommendations: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      priority: z.enum(RECOMMENDATION_PRIORITIES),
      topic_key: z.string().nullable(),
    }),
  ),
});

type Effort = 'low' | 'medium' | 'high';

/**
 * Adaptador (patrón Adapter) entre el puerto ReviewAnalyzer y la API de Claude.
 * Toda la dependencia del SDK de Anthropic vive en este archivo.
 */
export class ClaudeReviewAnalyzer implements ReviewAnalyzer {
  readonly batchSize = 40;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly logger: Logger,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 3, timeout: 180_000 });
  }

  get providerName(): string {
    return `claude:${this.model}`;
  }

  async discoverTopics(
    sample: readonly ReviewText[],
    context: BusinessContext,
    previousTopics: readonly TopicDefinition[] = [],
  ): Promise<TopicDefinition[]> {
    const out = await this.ask(topicDiscoveryPrompt(sample, context, previousTopics), TopicsOutput, 'medium', 'descubrir temas');
    return out.topics;
  }

  async classify(batch: readonly ReviewText[], topics: readonly TopicDefinition[]): Promise<ReviewClassification[]> {
    // Alias cortos (r1, r2…) en lugar de UUID: menos tokens y el modelo no ve IDs internos.
    const aliased = batch.map((review, i) => ({ alias: `r${i + 1}`, review }));
    const byAlias = new Map(aliased.map((a) => [a.alias, a.review.id]));

    const out = await this.ask(classificationPrompt(aliased, topics), ClassificationOutput, 'low', 'clasificar reseñas');

    return out.results.flatMap((r) => {
      const reviewId = byAlias.get(r.id);
      if (!reviewId) return [];
      return [{ reviewId, sentiment: Sentiment.of(r.sentiment, r.score), topicKeys: r.topics }];
    });
  }

  async recommend(stats: InsightStats, context: BusinessContext): Promise<RecommendationDraft[]> {
    const out = await this.ask(recommendationPrompt(stats, context), RecommendationsOutput, 'high', 'generar recomendaciones');
    return out.recommendations.slice(0, 6).map((r) => ({
      title: r.title.trim().slice(0, 120),
      detail: r.detail.trim().slice(0, 800),
      priority: r.priority,
      topicKey: r.topic_key,
    }));
  }

  private async ask<T extends z.ZodType>(prompt: string, schema: T, effort: Effort, step: string): Promise<z.infer<T>> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort, format: betaZodOutputFormat(schema) },
        // Si el clasificador de seguridad rechaza la petición, la API la reintenta con el modelo de respaldo.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      this.logger.info(
        { step, model: response.model, stop: response.stop_reason, usage: response.usage },
        'Respuesta de Claude',
      );

      if (response.stop_reason === 'refusal') {
        throw new AnalyzerError('La IA no pudo procesar estas reseñas. Revisa que el contenido sea apropiado.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new AnalyzerError('La respuesta de la IA quedó incompleta. Intenta con menos reseñas.', true);
      }
      if (!response.parsed_output) {
        throw new AnalyzerError('La IA devolvió una respuesta con formato inesperado. Intenta de nuevo.', true);
      }
      return response.parsed_output as z.infer<T>;
    } catch (err) {
      // El detalle técnico queda solo en el log del servidor; al usuario le llega un mensaje limpio.
      if (!(err instanceof AnalyzerError)) this.logger.warn({ err, step }, 'Fallo llamando a Claude');
      throw ClaudeReviewAnalyzer.translate(err, step);
    }
  }

  /** Traduce errores del SDK a errores del dominio con mensajes aptos para el usuario (sin detalles internos). */
  private static translate(err: unknown, step: string): AnalyzerError {
    if (err instanceof AnalyzerError) return err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return new AnalyzerError('La credencial del servicio de IA no es válida. Contacta al administrador.');
    }
    if (err instanceof Anthropic.NotFoundError) {
      return new AnalyzerError('El modelo de IA configurado no está disponible.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      return new AnalyzerError('El servicio de IA está ocupado. Intenta de nuevo en unos minutos.', true);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return new AnalyzerError('No se pudo conectar con el servicio de IA. Revisa la conexión.', true);
    }
    if (err instanceof Anthropic.APIError) {
      return new AnalyzerError(`El servicio de IA falló al ${step}. Intenta de nuevo.`, (err.status ?? 500) >= 500);
    }
    return new AnalyzerError(`Error inesperado al ${step}.`);
  }
}
