import { createHash, randomUUID } from 'node:crypto';
import { ValidationError } from '../errors/DomainError.js';
import { Rating } from '../value-objects/Rating.js';

export const REVIEW_MIN_LENGTH = 3;
export const REVIEW_MAX_LENGTH = 2000;

export const REVIEW_SOURCES = ['csv', 'manual'] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export interface ReviewProps {
  id: string;
  businessId: string;
  content: string;
  contentHash: string;
  rating: Rating | null;
  source: ReviewSource;
  authoredAt: Date | null;
  createdAt: Date;
}

// Caracteres de control (excepto tab y saltos de línea, que luego se colapsan).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Reseña cruda de un cliente: la materia prima que la IA convierte en insights. */
export class Review {
  private constructor(private readonly props: ReviewProps) {}

  static create(input: {
    businessId: string;
    content: string;
    rating?: Rating | null;
    source: ReviewSource;
    authoredAt?: Date | null;
  }): Review {
    const content = Review.normalize(input.content);
    if (content.length < REVIEW_MIN_LENGTH) {
      throw new ValidationError('La reseña es demasiado corta');
    }
    if (content.length > REVIEW_MAX_LENGTH) {
      throw new ValidationError(`La reseña supera los ${REVIEW_MAX_LENGTH} caracteres`);
    }
    const authoredAt =
      input.authoredAt && !Number.isNaN(input.authoredAt.getTime()) ? input.authoredAt : null;
    return new Review({
      id: randomUUID(),
      businessId: input.businessId,
      content,
      contentHash: Review.hash(content),
      rating: input.rating ?? null,
      source: input.source,
      authoredAt,
      createdAt: new Date(),
    });
  }

  static restore(props: ReviewProps): Review {
    return new Review(props);
  }

  /** Quita caracteres de control y colapsa espacios: evita basura y duplicados "invisibles". */
  static normalize(raw: string): string {
    return raw.normalize('NFC').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  }

  /** Huella para deduplicar: la misma reseña cargada dos veces no infla las estadísticas. */
  static hash(content: string): string {
    return createHash('sha256').update(content.toLowerCase()).digest('hex');
  }

  get id(): string { return this.props.id; }
  get businessId(): string { return this.props.businessId; }
  get content(): string { return this.props.content; }
  get contentHash(): string { return this.props.contentHash; }
  get rating(): Rating | null { return this.props.rating; }
  get source(): ReviewSource { return this.props.source; }
  get authoredAt(): Date | null { return this.props.authoredAt; }
  get createdAt(): Date { return this.props.createdAt; }

  toJSON() {
    return {
      id: this.id,
      content: this.content,
      rating: this.rating?.value ?? null,
      source: this.source,
      authoredAt: this.authoredAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
