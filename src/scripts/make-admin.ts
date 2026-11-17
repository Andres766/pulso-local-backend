import { loadConfig } from '../config/env.js';
import { Email } from '../domain/value-objects/Email.js';
import { Database } from '../infrastructure/db/Database.js';
import { runMigrations } from '../infrastructure/db/migrate.js';
import { PgUserRepository } from '../infrastructure/db/repositories/PgUserRepository.js';

/**
 * Da o quita el rol de administrador desde el servidor (nunca desde la web: así no existe una
 * ruta HTTP que permita escalar privilegios).
 *
 *   npm run make-admin -- admin@pulsolocal.co            → lo vuelve administrador
 *   npm run make-admin -- admin@pulsolocal.co --quitar   → lo devuelve a usuario normal
 *
 * La cuenta debe existir (registrarse primero en la app). En producción también sirve la variable
 * ADMIN_EMAILS, que se aplica al arrancar el servidor.
 */
async function main(): Promise<void> {
  const [rawEmail, flag] = process.argv.slice(2);
  if (!rawEmail) throw new Error('Uso: npm run make-admin -- correo@dominio.co [--quitar]');
  const revoke = flag === '--quitar';

  const db = new Database(loadConfig().DATABASE_URL);
  try {
    await runMigrations(db);
    const users = new PgUserRepository(db);
    const user = await users.findByEmail(Email.create(rawEmail));
    if (!user) throw new Error(`No existe una cuenta con el correo ${rawEmail}: regístrala primero en la app.`);

    if (revoke) user.revokeAdmin();
    else user.promoteToAdmin();
    await users.save(user);
    console.log(`${user.email.value} ahora es ${user.isAdmin ? 'administrador' : 'usuario normal'}.`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
