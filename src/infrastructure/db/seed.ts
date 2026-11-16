import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../config/env.js';
import { Business } from '../../domain/entities/Business.js';
import { Review } from '../../domain/entities/Review.js';
import { User } from '../../domain/entities/User.js';
import { Email } from '../../domain/value-objects/Email.js';
import { Rating } from '../../domain/value-objects/Rating.js';
import { CsvReviewParser } from '../csv/ReviewTextParsers.js';
import { BcryptPasswordHasher } from '../security/BcryptPasswordHasher.js';
import { Database } from './Database.js';
import { DEMO_BUSINESSES, DEMO_USER, endOfLocalDay, parseLocalDate, SAMPLES_DIR } from './demoData.js';
import { runMigrations } from './migrate.js';
import { PgBusinessRepository } from './repositories/PgBusinessRepository.js';
import { PgReviewRepository } from './repositories/PgReviewRepository.js';
import { PgUserRepository } from './repositories/PgUserRepository.js';

/** Lee `--hasta dd/mm/aaaa` de los argumentos (fin de ese día, hora local). */
function cutoffFromArgs(argv: readonly string[]): Date | null {
  const i = argv.indexOf('--hasta');
  if (i === -1) return null;
  const date = endOfLocalDay(argv[i + 1] ?? '');
  if (!date) throw new Error('Uso: npm run seed -- --hasta dd/mm/aaaa');
  return date;
}

/**
 * Datos de demostración escritos directo en la base (solo desarrollo): un usuario con cinco negocios de
 * rubros distintos, para mostrar que la IA descubre temas diferentes según el tipo de negocio.
 * Es idempotente: se puede ejecutar varias veces sin duplicar nada.
 * Credenciales: demo@pulsolocal.co / Galeras2026Pasto
 *
 * `--hasta dd/mm/aaaa` carga solo las reseñas escritas hasta esa fecha. Sirve para armar un
 * historial: seed con fecha de corte → analizar → seed completo → volver a analizar, y así el
 * dashboard muestra la evolución entre los dos análisis.
 */
async function seed(): Promise<void> {
  const config = loadConfig();
  const cutoff = cutoffFromArgs(process.argv.slice(2));
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
      const selected = rows
        .map((r) => ({ ...r, authoredAt: parseLocalDate(r.date) }))
        .filter((r) => !cutoff || (r.authoredAt !== null && r.authoredAt <= cutoff));
      const inserted = await reviews.saveMany(
        selected.map((r) =>
          Review.create({
            businessId,
            content: r.content,
            rating: Rating.tryParse(r.rating),
            authoredAt: r.authoredAt,
            source: 'csv',
          }),
        ),
      );
      console.log(`  · ${demo.name}: ${inserted} reseñas nuevas (de ${selected.length})`);
    }
    console.log(`Seed listo${cutoff ? ` (hasta ${cutoff.toLocaleDateString('es-CO')})` : ''}: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  } finally {
    await db.close();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
