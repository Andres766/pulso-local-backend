import { ValidationError } from '../errors/DomainError.js';

export const SENTIMENT_LABELS = ['positive', 'neutral', 'negative'] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

/**
 * Sentimiento de una reseña: etiqueta + puntaje continuo en [-1, 1].
 * Encapsula la regla de coherencia entre ambos para que ningún proveedor de IA
 * pueda devolver, por ejemplo, "positive" con puntaje -0.9.
 */
export class Sentiment {
  private static readonly NEUTRAL_BAND = 0.2;

  private constructor(
    readonly label: SentimentLabel,
    readonly score: number,
  ) {}

  static of(label: SentimentLabel, score: number): Sentiment {
    if (!SENTIMENT_LABELS.includes(label)) {
      throw new ValidationError(`Sentimiento desconocido: ${String(label)}`);
    }
    if (!Number.isFinite(score)) {
      throw new ValidationError('El puntaje de sentimiento debe ser numérico');
    }
    const clamped = Math.max(-1, Math.min(1, score));
    return new Sentiment(label, Sentiment.reconcile(label, clamped));
  }

  /** Deriva la etiqueta a partir del puntaje (usado por el analizador heurístico). */
  static fromScore(score: number): Sentiment {
    const clamped = Math.max(-1, Math.min(1, score));
    const label: SentimentLabel =
      clamped > Sentiment.NEUTRAL_BAND ? 'positive' : clamped < -Sentiment.NEUTRAL_BAND ? 'negative' : 'neutral';
    return new Sentiment(label, clamped);
  }

  private static reconcile(label: SentimentLabel, score: number): number {
    if (label === 'positive' && score < 0) return Math.abs(score);
    if (label === 'negative' && score > 0) return -score;
    return score;
  }
}
