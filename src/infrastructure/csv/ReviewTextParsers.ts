import { parse } from 'csv-parse/sync';
import type { RawReviewRow } from '../../application/use-cases/reviews/ReviewUseCases.js';
import { ValidationError } from '../../domain/errors/DomainError.js';

/**
 * Parsers de entrada (patrón Strategy + Adapter): convierten formatos externos
 * a filas RawReviewRow que entiende el caso de uso ImportReviews.
 */
export interface ReviewSourceParser {
  parse(input: string): RawReviewRow[];
}

const CONTENT_ALIASES = ['texto', 'text', 'comentario', 'comentarios', 'reseña', 'resena', 'review', 'opinion', 'opinión', 'contenido', 'content'];
const RATING_ALIASES = ['calificacion', 'calificación', 'rating', 'estrellas', 'stars', 'puntaje', 'nota'];
const DATE_ALIASES = ['fecha', 'date', 'created_at', 'fecha_resena'];

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/^﻿/, '');

/**
 * CSV con cabecera. Detecta el delimitador (coma o punto y coma, habitual en Excel en español)
 * y reconoce nombres de columna comunes en español e inglés.
 */
export class CsvReviewParser implements ReviewSourceParser {
  parse(input: string): RawReviewRow[] {
    const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
    const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

    let records: Record<string, string>[];
    try {
      records = parse(input, {
        columns: (header: string[]) => header.map(normalizeHeader),
        delimiter,
        bom: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        max_record_size: 10_000,
      });
    } catch {
      throw new ValidationError('El archivo CSV está mal formado');
    }

    if (records.length === 0) return [];
    const headers = Object.keys(records[0]!);
    const find = (aliases: string[]) => headers.find((h) => aliases.includes(h));
    const contentCol = find(CONTENT_ALIASES);
    if (!contentCol) {
      throw new ValidationError(`No se encontró la columna de texto. Usa una de: ${CONTENT_ALIASES.slice(0, 5).join(', ')}`);
    }
    const ratingCol = find(RATING_ALIASES);
    const dateCol = find(DATE_ALIASES);

    return records.map((r) => ({
      content: r[contentCol] ?? '',
      rating: ratingCol ? r[ratingCol] : undefined,
      date: dateCol ? r[dateCol] : undefined,
    }));
  }
}

/** Texto pegado: una reseña por línea, o bloques separados por líneas en blanco si las hay. */
export class PastedTextParser implements ReviewSourceParser {
  parse(input: string): RawReviewRow[] {
    const text = input.replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    const chunks = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split('\n');
    return chunks
      .map((c) => c.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
      .map((content) => ({ content }));
  }
}
