import { describe, expect, it } from 'vitest';
import { evaluateSentiment } from '../../src/application/evaluation/SentimentMetrics.js';

describe('evaluateSentiment', () => {
  it('calcula exactitud, precisión, cobertura, F1 y la matriz de confusión', () => {
    const report = evaluateSentiment([
      { expected: 'positive', predicted: 'positive', kind: 'directo' },
      { expected: 'positive', predicted: 'neutral', kind: 'directo' },
      { expected: 'negative', predicted: 'negative', kind: 'sarcasmo' },
      { expected: 'negative', predicted: 'positive', kind: 'sarcasmo' },
      { expected: 'neutral', predicted: 'neutral' },
      { expected: 'neutral', predicted: null }, // el motor no respondió: cuenta como error
    ]);

    expect(report.total).toBe(6);
    expect(report.accuracy).toBe(0.5);
    // positive: 1 acierto de 2 predichos como positive (precisión 0.5) y de 2 reales (cobertura 0.5)
    expect(report.perClass.positive).toEqual({ precision: 0.5, recall: 0.5, f1: 0.5, support: 2 });
    // neutral: 1 acierto de 2 predichos (0.5) y de 2 reales, uno sin respuesta (0.5)
    expect(report.perClass.neutral).toMatchObject({ precision: 0.5, recall: 0.5, support: 2 });
    expect(report.perClass.negative).toMatchObject({ precision: 1, recall: 0.5 });
    expect(report.confusion.negative).toEqual({ positive: 1, neutral: 0, negative: 1, missing: 0 });
    expect(report.confusion.neutral.missing).toBe(1);
    expect(report.accuracyByKind.sarcasmo).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(report.macroF1).toBeCloseTo((0.5 + 0.5 + 0.667) / 3, 2);
  });

  it('no divide por cero si una clase nunca aparece', () => {
    const report = evaluateSentiment([{ expected: 'positive', predicted: 'positive' }]);
    expect(report.perClass.negative).toEqual({ precision: 0, recall: 0, f1: 0, support: 0 });
    expect(report.accuracy).toBe(1);
  });
});
