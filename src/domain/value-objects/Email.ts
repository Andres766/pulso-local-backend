import { ValidationError } from '../errors/DomainError.js';

/** Value object inmutable: un Email siempre está normalizado y es válido. */
export class Email {
  private static readonly PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  private constructor(readonly value: string) {}

  static create(raw: string): Email {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length > 254 || !Email.PATTERN.test(normalized)) {
      throw new ValidationError('El correo electrónico no es válido');
    }
    return new Email(normalized);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
