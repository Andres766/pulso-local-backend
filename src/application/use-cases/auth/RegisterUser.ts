import { User } from '../../../domain/entities/User.js';
import { ConflictError, ValidationError } from '../../../domain/errors/DomainError.js';
import type { UserRepository } from '../../../domain/ports/Repositories.js';
import type { PasswordHasher } from '../../../domain/ports/Services.js';
import { Email } from '../../../domain/value-objects/Email.js';

export interface RegisterUserInput {
  email: string;
  name: string;
  password: string;
}

export const PASSWORD_MIN_LENGTH = 10;
// bcrypt solo usa los primeros 72 bytes: se rechaza lo que exceda para no truncar en silencio.
export const PASSWORD_MAX_BYTES = 72;

export class RegisterUser {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(input: RegisterUserInput): Promise<User> {
    const email = Email.create(input.email);
    RegisterUser.assertStrongPassword(input.password, email);

    if (await this.users.findByEmail(email)) {
      throw new ConflictError('Ya existe una cuenta con ese correo');
    }

    const user = User.register({ email, name: input.name, passwordHash: await this.hasher.hash(input.password) });
    await this.users.save(user);
    return user;
  }

  static assertStrongPassword(password: string, email: Email): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new ValidationError(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
    }
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
      throw new ValidationError('La contraseña es demasiado larga');
    }
    if (!/[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(password) || !/\d/.test(password)) {
      throw new ValidationError('La contraseña debe combinar letras y números');
    }
    if (password.toLowerCase().includes(email.value.split('@')[0]!)) {
      throw new ValidationError('La contraseña no puede contener tu correo');
    }
  }
}
