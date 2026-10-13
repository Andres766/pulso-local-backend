import type { ReviewWithInsight } from '../../domain/ports/Repositories.js';

const SENTIMENT_ES = { positive: 'Positiva', neutral: 'Neutra', negative: 'Negativa' } as const;

/**
 * Serializa reseñas analizadas a CSV para abrir en Excel (configuración regional es-CO):
 * separador ";", BOM UTF-8 para que las tildes se vean bien y saltos de línea CRLF.
 *
 * Seguridad — CSV/Formula injection (OWASP): una reseña escrita por un tercero que empiece por
 * "=", "+", "-", "@", tabulador o retorno de carro se ejecutaría como fórmula al abrir el archivo
 * (p. ej. =HYPERLINK(...) para exfiltrar datos). Esas celdas se neutralizan anteponiendo una
 * comilla simple, que Excel interpreta como "esto es texto".
 */
export class CsvReviewExporter {
  private static readonly DELIMITER = ';';
  private static readonly HEADERS = ['fecha', 'reseña', 'calificacion', 'sentimiento', 'puntaje', 'temas', 'origen'];

  serialize(items: readonly ReviewWithInsight[]): string {
    const lines = [CsvReviewExporter.HEADERS, ...items.map(CsvReviewExporter.toRow)].map((cells) =>
      cells.map((c) => CsvReviewExporter.cell(c)).join(CsvReviewExporter.DELIMITER),
    );
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  /** Neutraliza fórmulas y aplica el escape estándar de CSV (RFC 4180). */
  static cell(value: string | number | null): string {
    if (value === null) return '';
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  private static toRow({ review, sentiment, sentimentScore, topics }: ReviewWithInsight): (string | number | null)[] {
    const date = review.authoredAt ?? review.createdAt;
    return [
      date.toISOString().slice(0, 10),
      review.content,
      review.rating?.value ?? null,
      sentiment ? SENTIMENT_ES[sentiment] : 'Sin analizar',
      sentimentScore,
      topics.join(', '),
      review.source,
    ];
  }
}
