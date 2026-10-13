import type { InsightReport, InsightStats } from '../model/Insight.js';

/** Cambios menores a este umbral (en puntos porcentuales) se consideran ruido. */
export const STABLE_THRESHOLD_PP = 2;

export type TopicTrend = 'new' | 'resolved' | 'improved' | 'worsened' | 'stable';

export interface TopicChange {
  key: string;
  name: string;
  /** % del total de reseñas que se quejan del tema, ahora y antes. */
  complaintShare: number;
  previousComplaintShare: number | null;
  /** Diferencia en puntos porcentuales (positivo = MÁS quejas). */
  complaintDelta: number | null;
  trend: TopicTrend;
}

export interface InsightComparison {
  previousTotalReviews: number;
  /** Diferencias en puntos porcentuales sobre el total de reseñas de cada análisis. */
  positiveShareDelta: number;
  negativeShareDelta: number;
  averageScoreDelta: number;
  topics: TopicChange[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const share = (part: number, total: number) => (total === 0 ? 0 : (part / total) * 100);

/**
 * Servicio de dominio puro que compara dos reportes: responde "¿mejoró mi negocio desde el
 * último análisis?". Los temas se emparejan por su key, que el pipeline mantiene estable
 * entre análisis (la IA recibe la taxonomía anterior y la reutiliza).
 */
export class InsightComparator {
  compare(current: InsightReport, previous: InsightReport): InsightComparison {
    const now = current.stats;
    const before = previous.stats;

    const topics: TopicChange[] = now.topics.map((t) => {
      const old = before.topics.find((p) => p.key === t.key);
      if (!old) {
        return { key: t.key, name: t.name, complaintShare: t.complaintShare, previousComplaintShare: null, complaintDelta: null, trend: 'new' };
      }
      const delta = round1(t.complaintShare - old.complaintShare);
      return {
        key: t.key,
        name: t.name,
        complaintShare: t.complaintShare,
        previousComplaintShare: old.complaintShare,
        complaintDelta: delta,
        trend: InsightComparator.trendOf(delta),
      };
    });

    // Temas que antes tenían quejas y ahora ni se mencionan: problema resuelto.
    for (const old of before.topics) {
      if (old.complaintShare > 0 && !now.topics.some((t) => t.key === old.key)) {
        topics.push({
          key: old.key,
          name: old.name,
          complaintShare: 0,
          previousComplaintShare: old.complaintShare,
          complaintDelta: round1(-old.complaintShare),
          trend: 'resolved',
        });
      }
    }

    return {
      previousTotalReviews: before.totalReviews,
      positiveShareDelta: InsightComparator.sentimentDelta(now, before, 'positive'),
      negativeShareDelta: InsightComparator.sentimentDelta(now, before, 'negative'),
      averageScoreDelta: Math.round((now.sentiment.averageScore - before.sentiment.averageScore) * 100) / 100,
      topics,
    };
  }

  private static trendOf(delta: number): TopicTrend {
    if (Math.abs(delta) < STABLE_THRESHOLD_PP) return 'stable';
    return delta < 0 ? 'improved' : 'worsened';
  }

  private static sentimentDelta(now: InsightStats, before: InsightStats, label: 'positive' | 'negative'): number {
    return round1(share(now.sentiment[label], now.totalReviews) - share(before.sentiment[label], before.totalReviews));
  }
}
