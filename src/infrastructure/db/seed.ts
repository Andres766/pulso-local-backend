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
 * Datos de demostración (solo desarrollo y la cuenta demo): un usuario con cinco negocios de
 * rubros distintos, para mostrar que la IA descubre temas diferentes según el tipo de negocio.
 * Es idempotente: se puede ejecutar varias veces sin duplicar nada.
 * Credenciales: demo@pulsolocal.co / Galeras2026Pasto
 *
 * `--hasta dd/mm/aaaa` carga solo las reseñas escritas hasta esa fecha. Sirve para armar un
 * historial: seed con fecha de corte → analizar → seed completo → volver a analizar, y así el
 * dashboard muestra la evolución entre los dos análisis.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(here, '../../../samples');

const DEMO_USER = { email: 'demo@pulsolocal.co', name: 'Dueño Demo', password: 'Galeras2026Pasto' };

const DEMO_BUSINESSES: { name: string; category: BusinessCategory; city: string; csv: string }[] = [
  { name: 'Café Galeras', category: 'cafeteria', city: 'Pasto', csv: 'resenas_cafe_galeras.csv' },
  { name: 'Restaurante El Fogón', category: 'restaurante', city: 'Pasto', csv: 'resenas_restaurante_fogon.csv' },
  { name: 'Peluquería Lunaria', category: 'belleza', city: 'Pasto', csv: 'resenas_peluqueria_lunaria.csv' },
  { name: 'Artesanías Mopa-Mopa', category: 'tienda', city: 'Pasto', csv: 'resenas_artesanias_mopa_mopa.csv' },
  { name: 'Taller Mecánico Chapal', category: 'servicios', city: 'Pasto', csv: 'resenas_taller_chapal.csv' },
];

/** Las fechas de los CSV de ejemplo vienen como dd/mm/aaaa. */
function parseLocalDate(raw: unknown): Date | null {
  const [d, m, y] = String(raw).split('/').map(Number);
  return d && m && y ? new Date(y, m - 1, d) : null;
}

/** Lee `--hasta dd/mm/aaaa` de los argumentos (fin de ese día, hora local). */
function cutoffFromArgs(argv: readonly string[]): Date | null {
  const i = argv.indexOf('--hasta');
  if (i === -1) return null;
  const date = parseLocalDate(argv[i + 1]);
  if (!date) throw new Error('Uso: npm run seed -- --hasta dd/mm/aaaa');
  date.setHours(23, 59, 59, 999);
  return date;
}

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
