import { Review, type ReviewSource } from '../../../domain/entities/Review.js';
import { ValidationError } from '../../../domain/errors/DomainError.js';
import type { ReviewFilter, ReviewRepository, ReviewWithInsight } from '../../../domain/ports/Repositories.js';
import { Rating } from '../../../domain/value-objects/Rating.js';
import type { BusinessAccess } from '../businesses/BusinessAccess.js';

export const MAX_REVIEWS_PER_IMPORT = 2000;

/** Fila ya extraída de un CSV o de texto pegado, todavía sin validar. */
export interface RawReviewRow {
  content: string;
  rating?: unknown;
  date?: unknown;
}

export interface ImportSummary {
  received: number;
  imported: number;
  duplicates: number;
  rejected: { row: number; reason: string }[];
}

/**
 * Importa reseñas crudas. Las filas inválidas no abortan toda la carga:
 * se reportan una por una para que el dueño sepa qué corregir.
 */
export class ImportReviews {
  constructor(
    private readonly access: BusinessAccess,
    private readonly reviews: ReviewRepository,
  ) {}

  async execute(businessId: string, userId: string, rows: readonly RawReviewRow[], source: ReviewSource): Promise<ImportSummary> {
    await this.access.requireOwned(businessId, userId);

    if (rows.length === 0) throw new ValidationError('No se encontraron reseñas para importar');
    if (rows.length > MAX_REVIEWS_PER_IMPORT) {
      throw new ValidationError(`Máximo ${MAX_REVIEWS_PER_IMPORT} reseñas por carga`);
    }

    const rejected: ImportSummary['rejected'] = [];
    const unique = new Map<string, Review>();

    rows.forEach((row, index) => {
      try {
        const review = Review.create({
          businessId,
          content: String(row.content ?? ''),
          rating: Rating.tryParse(row.rating),
          authoredAt: ImportReviews.parseDate(row.date),
          source,
        });
        unique.set(review.contentHash, review);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        rejected.push({ row: index + 1, reason: err.message });
      }
    });

    const imported = await this.reviews.saveMany([...unique.values()]);
    const valid = rows.length - rejected.length;
    return { received: rows.length, imported, duplicates: valid - imported, rejected: rejected.slice(0, 50) };
  }

  private static parseDate(raw: unknown): Date | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const text = String(raw).trim();
    // Acepta ISO (2026-09-01) y el formato local dd/mm/aaaa.
    const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    const date = local ? new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1])) : new Date(text);
    if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 86_400_000) return null;
    return date;
  }
}

export class ListReviews {
  constructor(
    private readonly access: BusinessAccess,
    private readonly reviews: ReviewRepository,
  ) {}

  async execute(businessId: string, userId: string, filter: ReviewFilter): Promise<{ items: ReviewWithInsight[]; total: number }> {
    await this.access.requireOwned(businessId, userId);
    return this.reviews.search(businessId, filter);
  }
}

/** Tope de filas por exportación: evita respuestas gigantes y consultas costosas. */
export const MAX_EXPORT_ROWS = 10_000;

/** Reúne todas las reseñas del negocio con el resultado del último análisis, para exportarlas. */
export class ExportReviews {
  constructor(
    private readonly access: BusinessAccess,
    private readonly reviews: ReviewRepository,
  ) {}

  async execute(businessId: string, userId: string): Promise<{ businessName: string; items: ReviewWithInsight[] }> {
    const business = await this.access.requireOwned(businessId, userId);
    const { items } = await this.reviews.search(businessId, { limit: MAX_EXPORT_ROWS, offset: 0 });
    return { businessName: business.name, items };
  }
}

export class ClearReviews {
  constructor(
    private readonly access: BusinessAccess,
    private readonly reviews: ReviewRepository,
  ) {}

  async execute(businessId: string, userId: string): Promise<number> {
    await this.access.requireOwned(businessId, userId);
    return this.reviews.deleteAll(businessId);
  }
}
