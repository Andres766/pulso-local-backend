import type { Review } from '../../../domain/entities/Review.js';
import { AnalyzerError, NotFoundError } from '../../../domain/errors/DomainError.js';
import type {
  BusinessContext,
  ReviewClassification,
  ReviewText,
  TopicDefinition,
} from '../../../domain/model/Insight.js';
import type { ReviewAnalyzer } from '../../../domain/ports/ReviewAnalyzer.js';
import type { AnalysisRepository, BusinessRepository, ReviewRepository } from '../../../domain/ports/Repositories.js';
import type { Logger } from '../../../domain/ports/Services.js';
import type { InsightAggregator } from '../../../domain/services/InsightAggregator.js';

const TOPIC_SAMPLE_SIZE = 120;
const MAX_TOPICS = 10;
const CLASSIFY_CONCURRENCY = 2;

/**
 * Orquesta el pipeline de IA (patrón Pipeline / Template Method a nivel de caso de uso):
 *
 *   reseñas ─▶ descubrir temas ─▶ clasificar por lotes ─▶ agregar cifras ─▶ recomendar ─▶ persistir
 *
 * El caso de uso no sabe qué proveedor de IA hay detrás (depende del puerto ReviewAnalyzer).
 */
export class ExecuteAnalysis {
  constructor(
    private readonly analyses: AnalysisRepository,
    private readonly businesses: BusinessRepository,
    private readonly reviews: ReviewRepository,
    private readonly analyzer: ReviewAnalyzer,
    private readonly aggregator: InsightAggregator,
    private readonly logger: Logger,
    private readonly maxReviews: number,
  ) {}

  async execute(runId: string): Promise<void> {
    const run = await this.analyses.findById(runId);
    if (!run) throw new NotFoundError(`Análisis ${runId} no encontrado`);

    const business = await this.businesses.findById(run.businessId);
    if (!business) throw new NotFoundError('Negocio no encontrado');

    run.start();
    await this.analyses.save(run);
    const startedAt = Date.now();

    try {
      const context: BusinessContext = { name: business.name, category: business.category, city: business.city };
      const reviews = (await this.reviews.listForAnalysis(business.id, this.maxReviews)).map(ExecuteAnalysis.toText);

      const topics = this.sanitizeTopics(await this.analyzer.discoverTopics(ExecuteAnalysis.sample(reviews), context));
      const classifications = await this.classifyAll(reviews, topics);
      const stats = this.aggregator.aggregate(reviews, topics, classifications);
      const drafts = await this.analyzer.recommend(stats, context);
      const recommendations = this.aggregator.rankRecommendations(drafts, stats);

      run.complete();
      await this.analyses.completeWithResults(run, {
        classifications,
        topics: stats.topics,
        recommendations,
        sentiment: stats.sentiment,
      });
      this.logger.info(
        { runId, reviews: reviews.length, topics: stats.topics.length, ms: Date.now() - startedAt },
        'Análisis completado',
      );
    } catch (err) {
      const message =
        err instanceof AnalyzerError ? err.message : 'Ocurrió un error inesperado durante el análisis. Intenta de nuevo.';
      this.logger.error({ runId, err }, 'Análisis fallido');
      run.fail(message);
      await this.analyses.save(run);
    }
  }

  /** Clasifica en lotes con concurrencia limitada (no saturar la API ni el rate limit). */
  private async classifyAll(reviews: ReviewText[], topics: TopicDefinition[]): Promise<ReviewClassification[]> {
    const batches: ReviewText[][] = [];
    for (let i = 0; i < reviews.length; i += this.analyzer.batchSize) {
      batches.push(reviews.slice(i, i + this.analyzer.batchSize));
    }

    const validKeys = new Set(topics.map((t) => t.key));
    const results: ReviewClassification[] = [];
    let next = 0;

    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        const ids = new Set(batch.map((r) => r.id));
        const output = await this.analyzer.classify(batch, topics);
        // Defensa ante salidas del modelo: se descartan IDs que no estaban en el lote y temas inventados.
        for (const c of output) {
          if (!ids.has(c.reviewId)) continue;
          ids.delete(c.reviewId);
          results.push({ ...c, topicKeys: [...new Set(c.topicKeys.filter((k) => validKeys.has(k)))] });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, batches.length) }, worker));
    return results;
  }

  private sanitizeTopics(topics: TopicDefinition[]): TopicDefinition[] {
    const seen = new Set<string>();
    const clean: TopicDefinition[] = [];
    for (const t of topics) {
      const key = t.key.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      clean.push({ key, name: t.name.trim().slice(0, 60), description: t.description.trim().slice(0, 200) });
    }
    if (clean.length === 0) throw new AnalyzerError('La IA no logró identificar temas en las reseñas');
    return clean.slice(0, MAX_TOPICS);
  }

  /** Muestra repartida uniformemente para que el descubrimiento de temas vea todo el rango temporal. */
  private static sample(reviews: ReviewText[]): ReviewText[] {
    if (reviews.length <= TOPIC_SAMPLE_SIZE) return reviews;
    const step = reviews.length / TOPIC_SAMPLE_SIZE;
    return Array.from({ length: TOPIC_SAMPLE_SIZE }, (_, i) => reviews[Math.floor(i * step)]!);
  }

  private static toText(review: Review): ReviewText {
    return { id: review.id, content: review.content, rating: review.rating?.value ?? null };
  }
}
