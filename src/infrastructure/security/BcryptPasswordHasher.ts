import bcrypt from 'bcryptjs';
import type { PasswordHasher } from '../../domain/ports/Services.js';

/** bcrypt con costo 12 (~250 ms): lento a propósito para frenar ataques de fuerza bruta offline. */
export class BcryptPasswordHasher implements PasswordHasher {
  constructor(private readonly cost = 12) {}

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.cost);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
