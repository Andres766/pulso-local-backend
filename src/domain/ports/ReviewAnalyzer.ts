import type {
  BusinessContext,
  InsightStats,
  RecommendationDraft,
  ReviewClassification,
  ReviewText,
  TopicDefinition,
} from '../model/Insight.js';

/**
 * Puerto (patrón Strategy) del motor de IA. El caso de uso de análisis depende de esta
 * interfaz, no de un proveedor concreto: hoy existen ClaudeReviewAnalyzer (LLM) y
 * HeuristicReviewAnalyzer (léxico en español, sin red). Cambiar de proveedor no toca
 * ni el dominio ni la aplicación.
 *
 * El análisis se hace en tres pasos para que los temas sean consistentes entre lotes:
 *   1. discoverTopics  → propone una taxonomía de temas a partir de una muestra.
 *   2. classify        → asigna sentimiento y temas (de esa taxonomía) a cada reseña.
 *   3. recommend       → redacta recomendaciones a partir de las cifras ya calculadas.
 */
export interface ReviewAnalyzer {
  /** Nombre que se guarda en cada análisis para trazabilidad (p. ej. "claude:claude-opus-5"). */
  readonly providerName: string;
  /** Cuántas reseñas procesa por llamada en classify(). */
  readonly batchSize: number;

  /**
   * @param previousTopics taxonomía del análisis anterior: el proveedor debe reutilizar sus keys
   *        cuando los temas sigan vigentes, para que la evolución entre análisis sea comparable.
   */
  discoverTopics(
    sample: readonly ReviewText[],
    context: BusinessContext,
    previousTopics?: readonly TopicDefinition[],
  ): Promise<TopicDefinition[]>;

  classify(batch: readonly ReviewText[], topics: readonly TopicDefinition[]): Promise<ReviewClassification[]>;

  recommend(stats: InsightStats, context: BusinessContext): Promise<RecommendationDraft[]>;
}
