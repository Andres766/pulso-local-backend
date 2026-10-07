import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Business } from '../../domain/entities/Business.js';
import { Review } from '../../domain/entities/Review.js';
import { User } from '../../domain/entities/User.js';
import { Email } from '../../domain/value-objects/Email.js';
import { Rating } from '../../domain/value-objects/Rating.js';
import { loadConfig } from '../../config/env.js';
import { CsvReviewParser } from '../csv/ReviewTextParsers.js';
import { BcryptPasswordHasher } from '../security/BcryptPasswordHasher.js';
import { Database } from './Database.js';
import { runMigrations } from './migrate.js';
import { PgBusinessRepository } from './repositories/PgBusinessRepository.js';
import { PgReviewRepository } from './repositories/PgReviewRepository.js';
import { PgUserRepository } from './repositories/PgUserRepository.js';

/**
 * Datos de demostración (solo desarrollo): usuario demo + "Café Galeras" con 40 reseñas.
 * Credenciales: demo@pulsolocal.co / Galeras2026Pasto
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV = path.resolve(here, '../../../samples/resenas_cafe_galeras.csv');

async function seed(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) throw new Error('El seed no se ejecuta en producción');

  const db = new Database(config.DATABASE_URL);
  try {
    await runMigrations(db);
    const users = new PgUserRepository(db);
    const businesses = new PgBusinessRepository(db);
    const reviews = new PgReviewRepository(db);

    const email = Email.create('demo@pulsolocal.co');
    let user = await users.findByEmail(email);
    if (!user) {
      user = User.register({ email, name: 'Dueño Demo', passwordHash: await new BcryptPasswordHasher().hash('Galeras2026Pasto') });
      await users.save(user);
    }

    let business = (await businesses.listByOwner(user.id)).find((b) => b.name === 'Café Galeras');
    if (!business) {
      business = Business.create({ ownerId: user.id, name: 'Café Galeras', category: 'cafeteria', city: 'Pasto' });
      await businesses.save(business);
    }

    const rows = new CsvReviewParser().parse(await readFile(SAMPLE_CSV, 'utf8'));
    const businessId = business.id;
    const inserted = await reviews.saveMany(
      rows.map((r) => {
        const [d, m, y] = String(r.date).split('/').map(Number);
        return Review.create({
          businessId,
          content: r.content,
          rating: Rating.tryParse(r.rating),
          authoredAt: new Date(y!, m! - 1, d!),
          source: 'csv',
        });
      }),
    );
    console.log(`Seed listo: demo@pulsolocal.co / Galeras2026Pasto · ${inserted} reseñas nuevas en "${business.name}"`);
  } finally {
    await db.close();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
