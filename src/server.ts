import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { Container } from './container.js';
import { Email } from './domain/value-objects/Email.js';
import { runMigrations } from './infrastructure/db/migrate.js';

async function main(): Promise<void> {
  const container = new Container(loadConfig());
  const { logger, config } = container;

  const applied = await runMigrations(container.db);
  if (applied.length) logger.info({ applied }, 'Migraciones aplicadas');

  // Administradores definidos por configuración (ADMIN_EMAILS): sin acceso directo a la base.
  const adminEmails = config.adminEmails.flatMap((raw) => {
    try {
      return [Email.create(raw)];
    } catch {
      logger.warn({ raw }, 'Correo inválido en ADMIN_EMAILS; se ignora');
      return [];
    }
  });
  const promoted = await container.promoteAdmins.execute(adminEmails);
  if (promoted.length) logger.info({ promoted }, 'Rol de administrador asignado');

  // Lo que quedó "running" por un reinicio vuelve a la cola (si le quedan intentos) y el worker arranca.
  const recovered = await container.analyses.recoverInterrupted('El análisis se interrumpió por un reinicio del servidor.');
  if (recovered.requeued || recovered.failed) logger.warn(recovered, 'Análisis interrumpidos recuperados');
  container.jobs.start();
  await container.realtimeBus.start();

  const server = createApp(container).listen(config.PORT, () => {
    logger.info({ port: config.PORT, ai: container.analyzer.providerName }, 'PulsoLocal API lista');
  });
  // El mismo servidor HTTP atiende el "Upgrade" a WebSocket en /api/ws.
  container.realtime.attach(server);

  // Apagado ordenado: deja de aceptar conexiones, espera el análisis en curso y cierra el pool.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Apagando…');
    container.realtime.close();
    void container.realtimeBus.stop();
    server.close(() => {
      void container.jobs
        .stop()
        .then(() => container.db.close())
        .finally(() => process.exit(0));
    });
    // Render da ~30 s antes de matar el proceso; si un análisis tarda más, se recupera al volver.
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
