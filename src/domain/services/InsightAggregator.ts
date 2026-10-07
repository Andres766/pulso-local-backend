import type {
  InsightStats,
  Recommendation,
  RecommendationDraft,
  ReviewClassification,
  ReviewText,
  TopicDefinition,
  TopicStat,
} from '../model/Insight.js';
import { RECOMMENDATION_PRIORITIES } from '../model/Insight.js';

const MAX_QUOTES_PER_TOPIC = 3;
const MAX_QUOTE_LENGTH = 220;

const percent = (part: number, total: number): number =>
  total === 0 ? 0 : Math.round((part / total) * 1000) / 10;

/**
 * Servicio de dominio puro (sin E/S): convierte clasificaciones individuales
 * en estadísticas agregadas y ordena las recomendaciones por impacto.
 * Al no depender de infraestructura se prueba con tests unitarios simples.
 */
export class InsightAggregator {
  aggregate(
    reviews: readonly ReviewText[],
    topics: readonly TopicDefinition[],
    classifications: readonly ReviewClassification[],
  ): InsightStats {
    const byId = new Map(reviews.map((r) => [r.id, r]));
    const valid = classifications.filter((c) => byId.has(c.reviewId));
    const total = valid.length;

    const sentiment = { positive: 0, neutral: 0, negative: 0, averageScore: 0 };
    let scoreSum = 0;
    for (const c of valid) {
      sentiment[c.sentiment.label] += 1;
      scoreSum += c.sentiment.score;
    }
    sentiment.averageScore = total === 0 ? 0 : Math.round((scoreSum / total) * 100) / 100;

    const topicStats: TopicStat[] = topics.map((topic) => {
      const matching = valid.filter((c) => c.topicKeys.includes(topic.key));
      const counts = { positive: 0, neutral: 0, negative: 0 };
      for (const c of matching) counts[c.sentiment.label] += 1;

      // Citas representativas: primero las más negativas (lo accionable), luego el resto.
      const quotes = [...matching]
        .sort((a, b) => a.sentiment.score - b.sentiment.score)
        .slice(0, MAX_QUOTES_PER_TOPIC)
        .map((c) => InsightAggregator.truncate(byId.get(c.reviewId)!.content));

      return {
        ...topic,
        mentions: matching.length,
        share: percent(matching.length, total),
        ...counts,
        complaintShare: percent(counts.negative, total),
        sampleQuotes: quotes,
      };
    });

    topicStats.sort((a, b) => b.mentions - a.mentions || b.negative - a.negative);

    return { totalReviews: total, sentiment, topics: topicStats.filter((t) => t.mentions > 0) };
  }

  /**
   * Adjunta la evidencia numérica calculada por el código a cada borrador de la IA
   * y los ordena: prioridad declarada y, a igualdad, mayor porcentaje de quejas primero.
   */
  rankRecommendations(drafts: readonly RecommendationDraft[], stats: InsightStats): Recommendation[] {
    const topicByKey = new Map(stats.topics.map((t) => [t.key, t]));
    const priorityWeight = (p: RecommendationDraft['priority']) => RECOMMENDATION_PRIORITIES.indexOf(p);

    return drafts
      .map((d) => {
        const topic = d.topicKey ? topicByKey.get(d.topicKey) : undefined;
        return {
          ...d,
          topicKey: topic ? topic.key : null,
          evidenceShare: topic ? topic.complaintShare : null,
          rank: 0,
        };
      })
      .sort(
        (a, b) =>
          priorityWeight(a.priority) - priorityWeight(b.priority) ||
          (b.evidenceShare ?? 0) - (a.evidenceShare ?? 0),
      )
      .map((r, index) => ({ ...r, rank: index + 1 }));
  }

  private static truncate(text: string): string {
    return text.length <= MAX_QUOTE_LENGTH ? text : `${text.slice(0, MAX_QUOTE_LENGTH - 1)}…`;
  }
}
