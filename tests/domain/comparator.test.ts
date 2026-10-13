import { describe, expect, it } from 'vitest';
import type { InsightReport, TopicStat } from '../../src/domain/model/Insight.js';
import { InsightComparator } from '../../src/domain/services/InsightComparator.js';

const topic = (key: string, complaintShare: number): TopicStat => ({
  key,
  name: key,
  description: '',
  mentions: 10,
  share: 25,
  positive: 0,
  neutral: 0,
  negative: 0,
  complaintShare,
  sampleQuotes: [],
});

const report = (total: number, positive: number, negative: number, avg: number, topics: TopicStat[]): InsightReport => ({
  stats: { totalReviews: total, sentiment: { positive, neutral: total - positive - negative, negative, averageScore: avg }, topics },
  recommendations: [],
});

describe('InsightComparator', () => {
  const comparator = new InsightComparator();

  it('calcula la variación del sentimiento en puntos porcentuales (aunque cambie el total)', () => {
    const before = report(40, 16, 16, 0, []); // 40 % / 40 %
    const now = report(50, 30, 10, 0.35, []); // 60 % / 20 %
    const c = comparator.compare(now, before);
    expect(c.positiveShareDelta).toBe(20);
    expect(c.negativeShareDelta).toBe(-20);
    expect(c.averageScoreDelta).toBe(0.35);
    expect(c.previousTotalReviews).toBe(40);
  });

  it('clasifica cada tema: mejoró, empeoró, estable, nuevo o resuelto', () => {
    const before = report(40, 10, 10, 0, [topic('espera', 25), topic('precio', 10), topic('limpieza', 5), topic('pagos', 7.5)]);
    const now = report(40, 10, 10, 0, [topic('espera', 10), topic('precio', 17.5), topic('limpieza', 6), topic('domicilios', 5)]);
    const byKey = Object.fromEntries(comparator.compare(now, before).topics.map((t) => [t.key, t]));

    expect(byKey.espera).toMatchObject({ trend: 'improved', complaintDelta: -15, previousComplaintShare: 25 });
    expect(byKey.precio).toMatchObject({ trend: 'worsened', complaintDelta: 7.5 });
    expect(byKey.limpieza).toMatchObject({ trend: 'stable', complaintDelta: 1 });
    expect(byKey.domicilios).toMatchObject({ trend: 'new', complaintDelta: null });
    expect(byKey.pagos).toMatchObject({ trend: 'resolved', complaintShare: 0, complaintDelta: -7.5 });
  });
});
