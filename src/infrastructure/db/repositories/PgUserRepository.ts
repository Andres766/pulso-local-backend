import { User } from '../../../domain/entities/User.js';
import type { UserRepository } from '../../../domain/ports/Repositories.js';
import { Email } from '../../../domain/value-objects/Email.js';
import type { Database } from '../Database.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
}

/** Repositorio + Data Mapper: traduce filas SQL ⇄ entidades de dominio. */
export class PgUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? PgUserRepository.toDomain(rows[0]) : null;
  }

  async findByEmail(email: Email): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.value]);
    return rows[0] ? PgUserRepository.toDomain(rows[0]) : null;
  }

  async save(user: User): Promise<void> {
    await this.db.query(
      `INSERT INTO users (id, email, name, password_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash`,
      [user.id, user.email.value, user.name, user.passwordHash, user.createdAt],
    );
  }

  private static toDomain(row: UserRow): User {
    return User.restore({
      id: row.id,
      email: Email.create(row.email),
      name: row.name,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    });
  }
}
