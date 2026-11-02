import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors/DomainError.js';
import type { Email } from '../value-objects/Email.js';

export interface UserProps {
  id: string;
  email: Email;
  name: string;
  passwordHash: string;
  /** Intentos de inicio de sesión fallidos seguidos (se reinicia al entrar o al bloquear). */
  failedLogins: number;
  lockedUntil: Date | null;
  createdAt: Date;
}

/** Intentos fallidos seguidos que bloquean la cuenta, y por cuánto tiempo. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

/** Dueño de uno o varios negocios. El hash solo sale de la entidad hacia el repositorio. */
export class User {
  private constructor(private props: UserProps) {}

  static register(input: { email: Email; name: string; passwordHash: string }): User {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 80) {
      throw new ValidationError('El nombre debe tener entre 2 y 80 caracteres');
    }
    return new User({
      id: randomUUID(),
      email: input.email,
      name,
      passwordHash: input.passwordHash,
      failedLogins: 0,
      lockedUntil: null,
      createdAt: new Date(),
    });
  }

  /**
   * Bloqueo por cuenta (complementa el límite por IP): tras MAX_FAILED_LOGINS fallos seguidos,
   * la cuenta no acepta ni la contraseña correcta durante LOCKOUT_MINUTES. Frena la fuerza bruta
   * distribuida (muchas IP atacando la misma cuenta).
   */
  isLocked(now = new Date()): boolean {
    return this.props.lockedUntil !== null && this.props.lockedUntil > now;
  }

  /** Minutos que faltan para el desbloqueo (0 si no está bloqueada). */
  minutesUntilUnlock(now = new Date()): number {
    if (!this.isLocked(now)) return 0;
    return Math.ceil((this.props.lockedUntil!.getTime() - now.getTime()) / 60_000);
  }

  registerFailedLogin(now = new Date()): void {
    const failed = this.props.failedLogins + 1;
    if (failed >= MAX_FAILED_LOGINS) {
      this.props = { ...this.props, failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) };
    } else {
      this.props = { ...this.props, failedLogins: failed };
    }
  }

  registerSuccessfulLogin(): void {
    this.props = { ...this.props, failedLogins: 0, lockedUntil: null };
  }

  /** Reconstituye una entidad ya persistida (sin volver a validar reglas de creación). */
  static restore(props: UserProps): User {
    return new User(props);
  }

  get id(): string {
    return this.props.id;
  }
  get email(): Email {
    return this.props.email;
  }
  get name(): string {
    return this.props.name;
  }
  get passwordHash(): string {
    return this.props.passwordHash;
  }
  get failedLogins(): number {
    return this.props.failedLogins;
  }
  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** Proyección segura para enviar al cliente: nunca incluye el hash. */
  toPublic(): { id: string; email: string; name: string } {
    return { id: this.id, email: this.email.value, name: this.name };
  }
}
