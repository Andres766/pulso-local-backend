import { AuthenticationError, ValidationError } from '../../../domain/errors/DomainError.js';
import type { UserRepository } from '../../../domain/ports/Repositories.js';
import type { PasswordHasher, SessionValidator, TokenPayload, TokenService } from '../../../domain/ports/Services.js';
import { RegisterUser } from './RegisterUser.js';

/**
 * Un JWT válido por firma no basta: la cuenta debe seguir existiendo y su versión de sesión debe
 * coincidir. Así cambiar la contraseña (o borrar la cuenta) cierra al instante las demás sesiones.
 */
export class ValidateSession implements SessionValidator {
  constructor(private readonly users: UserRepository) {}

  async isValid(payload: TokenPayload): Promise<boolean> {
    const user = await this.users.findById(payload.sub);
    return user !== null && user.tokenVersion === payload.ver;
  }
}

export class ChangePassword {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
  ) {}

  /** Devuelve un token nuevo: la sesión actual sigue abierta y las demás quedan cerradas. */
  async execute(userId: string, input: { currentPassword: string; newPassword: string }): Promise<string> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthenticationError('Sesión no válida');

    if (!(await this.hasher.verify(input.currentPassword, user.passwordHash))) {
      // Cuenta como intento fallido: este endpoint no puede servir para adivinar la contraseña.
      user.registerFailedLogin();
      await this.users.save(user);
      throw new AuthenticationError('La contraseña actual no es correcta');
    }
    RegisterUser.assertStrongPassword(input.newPassword, user.email);
    if (await this.hasher.verify(input.newPassword, user.passwordHash)) {
      throw new ValidationError('La nueva contraseña debe ser distinta de la actual');
    }

    user.changePassword(await this.hasher.hash(input.newPassword));
    await this.users.save(user);
    return this.tokens.sign({ sub: user.id, email: user.email.value, ver: user.tokenVersion });
  }
}

/**
 * Derecho de supresión (Ley 1581 de 2012, Habeas Data): el titular puede eliminar su cuenta y todos
 * sus datos. Se pide la contraseña para que una sesión olvidada abierta no baste para borrarlo todo.
 */
export class DeleteAccount {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(userId: string, password: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthenticationError('Sesión no válida');
    if (!(await this.hasher.verify(password, user.passwordHash))) {
      user.registerFailedLogin();
      await this.users.save(user);
      throw new AuthenticationError('La contraseña no es correcta');
    }
    await this.users.delete(user.id);
  }
}
