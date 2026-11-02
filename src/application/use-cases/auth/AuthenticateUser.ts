import type { User } from '../../../domain/entities/User.js';
import { AccountLockedError, AuthenticationError, ValidationError } from '../../../domain/errors/DomainError.js';
import type { UserRepository } from '../../../domain/ports/Repositories.js';
import type { PasswordHasher, TokenService } from '../../../domain/ports/Services.js';
import { Email } from '../../../domain/value-objects/Email.js';

export interface AuthResult {
  user: User;
  token: string;
}

export class AuthenticateUser {
  /**
   * Hash señuelo: si el correo no existe igual se ejecuta una verificación bcrypt,
   * de modo que el tiempo de respuesta no revela qué correos están registrados.
   */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
  ) {}

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash('pulso-local-dummy-password-1');
    return this.dummyHash;
  }

  async execute(input: { email: string; password: string }): Promise<AuthResult> {
    let email: Email;
    try {
      email = Email.create(input.email);
    } catch (err) {
      if (err instanceof ValidationError) throw new AuthenticationError();
      throw err;
    }

    const user = await this.users.findByEmail(email);
    if (user?.isLocked()) {
      // Mientras dura el bloqueo ni siquiera se verifica la contraseña (tampoco la correcta).
      throw new AccountLockedError(user.minutesUntilUnlock());
    }

    const valid = await this.hasher.verify(input.password, user?.passwordHash ?? (await this.getDummyHash()));
    if (!user) throw new AuthenticationError();
    if (!valid) {
      user.registerFailedLogin();
      await this.users.save(user);
      if (user.isLocked()) throw new AccountLockedError(user.minutesUntilUnlock());
      throw new AuthenticationError();
    }

    if (user.failedLogins > 0) {
      user.registerSuccessfulLogin();
      await this.users.save(user);
    }
    return { user, token: this.tokens.sign({ sub: user.id, email: user.email.value }) };
  }
}
