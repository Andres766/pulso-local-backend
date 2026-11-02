import { describe, expect, it } from 'vitest';
import { SentimentTrend } from '../../src/domain/services/SentimentTrend.js';

const point = (month: string, positive: number) => ({ month, positive, neutral: 0, negative: 0, total: positive, averageScore: 0.5 });

describe('SentimentTrend', () => {
  const trend = new SentimentTrend();

  it('ordena y rellena con ceros los meses sin reseñas, incluso al cambiar de año', () => {
    const series = trend.fillGaps([point('2027-01', 3), point('2026-10', 2)]);
    expect(series.map((p) => p.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
    expect(series[1]).toMatchObject({ total: 0, averageScore: null });
    expect(series[3]!.positive).toBe(3);
  });

  it('devuelve una serie vacía si no hay datos y descarta meses mal formados', () => {
    expect(trend.fillGaps([])).toEqual([]);
    expect(trend.fillGaps([point('octubre', 1)])).toEqual([]);
  });
});
