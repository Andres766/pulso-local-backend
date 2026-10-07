import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors/DomainError.js';
import { Email } from '../value-objects/Email.js';

export interface UserProps {
  id: string;
  email: Email;
  name: string;
  passwordHash: string;
  createdAt: Date;
}

/** Dueño de uno o varios negocios. El hash solo sale de la entidad hacia el repositorio. */
export class User {
  private constructor(private readonly props: UserProps) {}

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
      createdAt: new Date(),
    });
  }

  /** Reconstituye una entidad ya persistida (sin volver a validar reglas de creación). */
  static restore(props: UserProps): User {
    return new User(props);
  }

  get id(): string { return this.props.id; }
  get email(): Email { return this.props.email; }
  get name(): string { return this.props.name; }
  get passwordHash(): string { return this.props.passwordHash; }
  get createdAt(): Date { return this.props.createdAt; }

  /** Proyección segura para enviar al cliente: nunca incluye el hash. */
  toPublic(): { id: string; email: string; name: string } {
    return { id: this.id, email: this.email.value, name: this.name };
  }
}
