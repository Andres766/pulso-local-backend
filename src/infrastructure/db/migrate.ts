import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../config/env.js';
import { Database } from './Database.js';

/**
 * Migrador mínimo: aplica en orden los .sql de /migrations que aún no estén
 * registrados en schema_migrations, cada uno dentro de su propia transacción.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

export async function runMigrations(db: Database): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(200) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const executed: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await db.transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    executed.push(file);
  }
  return executed;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const db = new Database(loadConfig().DATABASE_URL);
  runMigrations(db)
    .then((done) => console.log(done.length ? `Migraciones aplicadas: ${done.join(', ')}` : 'Esquema al día'))
    .catch((err) => {
      console.error('Error aplicando migraciones:', err);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
