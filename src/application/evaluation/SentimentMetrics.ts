import { SENTIMENT_LABELS, type SentimentLabel } from '../../domain/value-objects/Sentiment.js';

export interface LabeledPrediction {
  expected: SentimentLabel;
  predicted: SentimentLabel | null;
  /** Categoría del caso (sarcasmo, negación, jerga…) para ver dónde falla cada motor. */
  kind?: string;
}

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface EvaluationReport {
  total: number;
  accuracy: number;
  macroF1: number;
  perClass: Record<SentimentLabel, ClassMetrics>;
  /** confusion[esperado][predicho]; "missing" cuenta las reseñas que el motor no clasificó. */
  confusion: Record<SentimentLabel, Record<SentimentLabel | 'missing', number>>;
  accuracyByKind: Record<string, { correct: number; total: number; accuracy: number }>;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);

/**
 * Métricas estándar de clasificación multiclase: exactitud, precisión, cobertura (recall) y F1 por
 * clase, F1 macro (promedio simple: no deja que la clase mayoritaria tape a las demás) y matriz de
 * confusión. Una predicción ausente cuenta como error.
 */
export function evaluateSentiment(predictions: readonly LabeledPrediction[]): EvaluationReport {
  const emptyRow = () => ({ positive: 0, neutral: 0, negative: 0, missing: 0 });
  const confusion = { positive: emptyRow(), neutral: emptyRow(), negative: emptyRow() };
  const byKind: Record<string, { correct: number; total: number }> = {};
  let correct = 0;

  for (const p of predictions) {
    confusion[p.expected][p.predicted ?? 'missing'] += 1;
    const hit = p.predicted === p.expected;
    if (hit) correct++;
    if (p.kind) {
      byKind[p.kind] ??= { correct: 0, total: 0 };
      byKind[p.kind]!.total += 1;
      if (hit) byKind[p.kind]!.correct += 1;
    }
  }

  const perClass = {} as Record<SentimentLabel, ClassMetrics>;
  for (const label of SENTIMENT_LABELS) {
    const tp = confusion[label][label];
    const predictedAsLabel = SENTIMENT_LABELS.reduce((n, e) => n + confusion[e][label], 0);
    const support = SENTIMENT_LABELS.reduce((n, p) => n + confusion[label][p], 0) + confusion[label].missing;
    const precision = safeDiv(tp, predictedAsLabel);
    const recall = safeDiv(tp, support);
    perClass[label] = {
      precision: round3(precision),
      recall: round3(recall),
      f1: round3(safeDiv(2 * precision * recall, precision + recall)),
      support,
    };
  }

  const macroF1 = SENTIMENT_LABELS.reduce((n, l) => n + perClass[l].f1, 0) / SENTIMENT_LABELS.length;
  const accuracyByKind = Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [k, { ...v, accuracy: round3(safeDiv(v.correct, v.total)) }]),
  );

  return {
    total: predictions.length,
    accuracy: round3(safeDiv(correct, predictions.length)),
    macroF1: round3(macroF1),
    perClass,
    confusion,
    accuracyByKind,
  };
}
