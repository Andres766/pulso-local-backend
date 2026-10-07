import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuración validada al arrancar (fail-fast): si falta un secreto o un valor
 * es inválido, el proceso no inicia en lugar de fallar más tarde en producción.
 */
const booleanFromString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_EXPIRES_IN_HOURS: z.coerce.number().int().min(1).max(72).default(8),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5180'),
  COOKIE_SECURE: booleanFromString.optional(),
  TRUST_PROXY: booleanFromString.default(false),
  AI_PROVIDER: z.enum(['auto', 'claude', 'heuristic']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction && /cambia|change|secret|example/i.test(env.JWT_SECRET)) {
    throw new Error('JWT_SECRET parece un valor de ejemplo; genera uno aleatorio para producción');
  }

  return {
    ...env,
    isProduction,
    cookieSecure: env.COOKIE_SECURE ?? isProduction,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
