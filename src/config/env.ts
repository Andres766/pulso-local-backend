import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuración validada al arrancar (fail-fast): si falta un secreto o un valor
 * es inválido, el proceso no inicia en lugar de fallar más tarde en producción.
 */
const booleanFromString = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_EXPIRES_IN_HOURS: z.coerce.number().int().min(1).max(72).default(8),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5180'),
  COOKIE_SECURE: booleanFromString.optional(),
  TRUST_PROXY: booleanFromString.default(false),
  AI_PROVIDER: z.enum(['auto', 'claude', 'gemini', 'heuristic']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5'),
  GEMINI_API_KEY: z.string().optional(),
  // Flash-Lite como principal: en el plan gratuito 3.5 Flash solo permite 20 llamadas al día por
  // proyecto (≈ 5 análisis); Flash-Lite midió la misma exactitud (93,3 %, docs/EVALUACION.md) y es más rápido.
  GEMINI_MODEL: z.string().default('gemini-flash-lite-latest'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.5-flash'),
  /** URL pública del WebSocket (wss://…). Si falta, se deriva de RENDER_EXTERNAL_URL o se usa el mismo origen. */
  PUBLIC_WS_URL: z.string().url().optional(),
  /** Render la define sola con la URL pública del servicio. */
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  /** Correos (separados por coma) que reciben el rol de administrador al arrancar, si ya tienen cuenta. */
  ADMIN_EMAILS: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

/** https://api.onrender.com → wss://api.onrender.com/api/ws; null = el navegador usa su mismo origen. */
function realtimeUrlFrom(explicit: string | undefined, renderUrl: string | undefined): string | null {
  if (explicit) return explicit;
  if (!renderUrl) return null;
  return `${renderUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/api/ws`;
}

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
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    realtimeUrl: realtimeUrlFrom(env.PUBLIC_WS_URL, env.RENDER_EXTERNAL_URL),
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  };
}
