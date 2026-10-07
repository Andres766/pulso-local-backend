import type { User } from '../../../domain/entities/User.js';
import { AuthenticationError } from '../../../domain/errors/DomainError.js';
import type { UserRepository } from '../../../domain/ports/Repositories.js';

export class GetCurrentUser {
  constructor(private readonly users: UserRepository) {}

  async execute(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    // El token puede ser válido pero la cuenta haberse eliminado: se trata como sesión inválida.
    if (!user) throw new AuthenticationError('Sesión no válida');
    return user;
  }
}
