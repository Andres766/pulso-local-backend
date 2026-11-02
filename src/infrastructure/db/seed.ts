import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../config/env.js';
import { Business, type BusinessCategory } from '../../domain/entities/Business.js';
import { Review } from '../../domain/entities/Review.js';
import { User } from '../../domain/entities/User.js';
import { Email } from '../../domain/value-objects/Email.js';
import { Rating } from '../../domain/value-objects/Rating.js';
import { CsvReviewParser } from '../csv/ReviewTextParsers.js';
import { BcryptPasswordHasher } from '../security/BcryptPasswordHasher.js';
import { Database } from './Database.js';
import { runMigrations } from './migrate.js';
import { PgBusinessRepository } from './repositories/PgBusinessRepository.js';
import { PgReviewRepository } from './repositories/PgReviewRepository.js';
import { PgUserRepository } from './repositories/PgUserRepository.js';

/**
 * Datos de demostración (solo desarrollo y la cuenta demo): un usuario con dos negocios de
 * rubros distintos, para mostrar que la IA descubre temas diferentes según el tipo de negocio.
 * Es idempotente: se puede ejecutar varias veces sin duplicar nada.
 * Credenciales: demo@pulsolocal.co / Galeras2026Pasto
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(here, '../../../samples');

const DEMO_USER = { email: 'demo@pulsolocal.co', name: 'Dueño Demo', password: 'Galeras2026Pasto' };

const DEMO_BUSINESSES: { name: string; category: BusinessCategory; city: string; csv: string }[] = [
  { name: 'Café Galeras', category: 'cafeteria', city: 'Pasto', csv: 'resenas_cafe_galeras.csv' },
  { name: 'Restaurante El Fogón', category: 'restaurante', city: 'Pasto', csv: 'resenas_restaurante_fogon.csv' },
];

/** Las fechas de los CSV de ejemplo vienen como dd/mm/aaaa. */
function parseLocalDate(raw: unknown): Date | null {
  const [d, m, y] = String(raw).split('/').map(Number);
  return d && m && y ? new Date(y, m - 1, d) : null;
}

async function seed(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) throw new Error('El seed no se ejecuta en producción');

  const db = new Database(config.DATABASE_URL);
  try {
    await runMigrations(db);
    const users = new PgUserRepository(db);
    const businesses = new PgBusinessRepository(db);
    const reviews = new PgReviewRepository(db);
    const parser = new CsvReviewParser();

    const email = Email.create(DEMO_USER.email);
    let user = await users.findByEmail(email);
    if (!user) {
      user = User.register({ email, name: DEMO_USER.name, passwordHash: await new BcryptPasswordHasher().hash(DEMO_USER.password) });
      await users.save(user);
    }

    const owned = await businesses.listByOwner(user.id);
    for (const demo of DEMO_BUSINESSES) {
      let business = owned.find((b) => b.name === demo.name);
      if (!business) {
        business = Business.create({ ownerId: user.id, name: demo.name, category: demo.category, city: demo.city });
        await businesses.save(business);
      }

      const businessId = business.id;
      const rows = parser.parse(await readFile(path.join(SAMPLES_DIR, demo.csv), 'utf8'));
      const inserted = await reviews.saveMany(
        rows.map((r) =>
          Review.create({
            businessId,
            content: r.content,
            rating: Rating.tryParse(r.rating),
            authoredAt: parseLocalDate(r.date),
            source: 'csv',
          }),
        ),
      );
      console.log(`  · ${demo.name}: ${inserted} reseñas nuevas (de ${rows.length})`);
    }
    console.log(`Seed listo: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  } finally {
    await db.close();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
