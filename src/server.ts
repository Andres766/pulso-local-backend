import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { Container } from './container.js';
import { runMigrations } from './infrastructure/db/migrate.js';

async function main(): Promise<void> {
  const container = new Container(loadConfig());
  const { logger, config } = container;

  const applied = await runMigrations(container.db);
  if (applied.length) logger.info({ applied }, 'Migraciones aplicadas');

  // Un análisis "running" tras un reinicio nunca terminará: se marca como fallido.
  const interrupted = await container.analyses.failInterrupted('El análisis se interrumpió por un reinicio del servidor.');
  if (interrupted) logger.warn({ interrupted }, 'Análisis interrumpidos marcados como fallidos');

  const server = createApp(container).listen(config.PORT, () => {
    logger.info({ port: config.PORT, ai: container.analyzer.providerName }, 'PulsoLocal API lista');
  });

  // Apagado ordenado: deja de aceptar conexiones y cierra el pool de la base de datos.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Apagando…');
    server.close(() => void container.db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
