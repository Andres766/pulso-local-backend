import { Business, type BusinessCategory } from '../../../domain/entities/Business.js';
import type { BusinessRepository } from '../../../domain/ports/Repositories.js';
import type { Database } from '../Database.js';

interface BusinessRow {
  id: string;
  owner_id: string;
  name: string;
  category: BusinessCategory;
  city: string | null;
  created_at: Date;
}

export class PgBusinessRepository implements BusinessRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Business | null> {
    const { rows } = await this.db.query<BusinessRow>('SELECT * FROM businesses WHERE id = $1', [id]);
    return rows[0] ? PgBusinessRepository.toDomain(rows[0]) : null;
  }

  async listByOwner(ownerId: string): Promise<Business[]> {
    const { rows } = await this.db.query<BusinessRow>(
      'SELECT * FROM businesses WHERE owner_id = $1 ORDER BY created_at ASC',
      [ownerId],
    );
    return rows.map(PgBusinessRepository.toDomain);
  }

  async save(business: Business): Promise<void> {
    await this.db.query(
      `INSERT INTO businesses (id, owner_id, name, category, city, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, city = EXCLUDED.city`,
      [business.id, business.ownerId, business.name, business.category, business.city, business.createdAt],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM businesses WHERE id = $1', [id]);
  }

  private static toDomain(row: BusinessRow): Business {
    return Business.restore({
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      category: row.category,
      city: row.city,
      createdAt: row.created_at,
    });
  }
}
