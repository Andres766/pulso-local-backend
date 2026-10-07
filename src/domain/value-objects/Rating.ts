import { ValidationError } from '../errors/DomainError.js';

/** Calificación opcional en estrellas (1 a 5) que traen algunas reseñas. */
export class Rating {
  private constructor(readonly value: number) {}

  static create(raw: number): Rating {
    if (!Number.isInteger(raw) || raw < 1 || raw > 5) {
      throw new ValidationError('La calificación debe ser un entero entre 1 y 5');
    }
    return new Rating(raw);
  }

  static tryParse(raw: unknown): Rating | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const rounded = Math.round(n);
    return rounded >= 1 && rounded <= 5 ? new Rating(rounded) : null;
  }
}
