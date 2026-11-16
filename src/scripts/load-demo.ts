import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEMO_BUSINESSES,
  DEMO_FIRST_WAVE_CUTOFF,
  DEMO_USER,
  endOfLocalDay,
  parseLocalDate,
  SAMPLES_DIR,
} from '../infrastructure/db/demoData.js';

/**
 * Carga los datos de demostración A TRAVÉS DE LA API, como lo haría un usuario. A diferencia del
 * seed (que escribe directo en la base y se niega a correr en producción), sirve para poblar una
 * base nueva en Render sin exponer su URL:
 *
 *   npm run demo -- https://pulso-local-frontend.vercel.app
 *
 * 1. Inicia sesión con la cuenta demo (o la registra si no existe) y crea los negocios que falten.
 * 2. Sube las reseñas hasta el 30/09/2026 y analiza cada negocio.
 * 3. Sube el resto y vuelve a analizar: el dashboard queda con la evolución entre dos análisis.
 *
 * Es idempotente en las reseñas (los duplicados se ignoran), pero cada ejecución lanza análisis
 * nuevos, que consumen cuota de la IA.
 */
const API_HEADERS = { 'X-Requested-With': 'PulsoLocal' };
const POLL_MS = 4000;

class DemoClient {
  private cookie = '';

  constructor(private readonly baseUrl: string) {}

  async call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
    const isForm = body instanceof FormData;
    const headers: Record<string, string> = { ...API_HEADERS, Cookie: this.cookie };
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}/api${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
  }

  async expect<T>(method: string, route: string, body?: unknown): Promise<T> {
    const { status, data } = await this.call<T>(method, route, body);
    if (status >= 300) throw new Error(`${method} ${route} → ${status} ${JSON.stringify(data)}`);
    return data;
  }
}

interface BusinessDto {
  id: string;
  name: string;
}
interface RunDto {
  id: string;
  status: string;
  reviewCount: number;
  error: string | null;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

async function signIn(client: DemoClient): Promise<void> {
  const login = await client.call('POST', '/auth/login', { email: DEMO_USER.email, password: DEMO_USER.password });
  if (login.status === 200) return;
  await client.expect('POST', '/auth/register', DEMO_USER);
}

async function ensureBusinesses(client: DemoClient): Promise<Map<string, string>> {
  const { items } = await client.expect<{ items: BusinessDto[] }>('GET', '/businesses');
  const ids = new Map(items.map((b) => [b.name, b.id]));
  for (const demo of DEMO_BUSINESSES) {
    if (ids.has(demo.name)) continue;
    const created = await client.expect<BusinessDto>('POST', '/businesses', { name: demo.name, category: demo.category, city: demo.city });
    ids.set(demo.name, created.id);
  }
  return ids;
}

/** Sube las filas del CSV de ejemplo que caen en la tanda pedida (antes o después del corte). */
async function uploadWave(client: DemoClient, ids: Map<string, string>, wave: 'first' | 'second'): Promise<void> {
  const cutoff = endOfLocalDay(DEMO_FIRST_WAVE_CUTOFF) as Date;
  for (const demo of DEMO_BUSINESSES) {
    const [header, ...rows] = (await readFile(path.join(SAMPLES_DIR, demo.csv), 'utf8')).trim().split('\n');
    const selected = rows.filter((row) => {
      const date = parseLocalDate(row.split(';')[0]);
      const inFirst = date !== null && date <= cutoff;
      return wave === 'first' ? inFirst : !inFirst;
    });
    const form = new FormData();
    form.append('file', new Blob([`${header}\n${selected.join('\n')}\n`], { type: 'text/csv' }), demo.csv);
    const summary = await client.expect<{ imported: number; duplicates: number }>(
      'POST',
      `/businesses/${ids.get(demo.name)}/reviews/csv`,
      form,
    );
    console.log(`  · ${demo.name}: ${summary.imported} reseñas nuevas, ${summary.duplicates} repetidas`);
  }
}

/** Analiza los negocios uno por uno (en serie, para no saturar la cuota de la IA). */
async function analyzeAll(client: DemoClient, ids: Map<string, string>): Promise<void> {
  for (const demo of DEMO_BUSINESSES) {
    const started = Date.now();
    let run = await client.expect<RunDto>('POST', `/businesses/${ids.get(demo.name)}/analyses`);
    while (run.status === 'pending' || run.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      run = await client.expect<RunDto>('GET', `/analyses/${run.id}`);
    }
    const tokens = run.usage.inputTokens + run.usage.outputTokens;
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
      `  · ${demo.name}: ${run.status}, ${run.reviewCount} reseñas, ${seconds} s, ${run.usage.calls} llamadas, ${tokens} tokens` +
        (run.error ? ` (${run.error})` : ''),
    );
  }
}

async function main(): Promise<void> {
  const baseUrl = process.argv[2]?.replace(/\/$/, '');
  if (!baseUrl) throw new Error('Uso: npm run demo -- <url del frontend o del backend>');
  const client = new DemoClient(baseUrl);

  await signIn(client);
  const ids = await ensureBusinesses(client);
  console.log(`Tanda 1: reseñas hasta el ${DEMO_FIRST_WAVE_CUTOFF}`);
  await uploadWave(client, ids, 'first');
  await analyzeAll(client, ids);
  console.log('Tanda 2: reseñas posteriores');
  await uploadWave(client, ids, 'second');
  await analyzeAll(client, ids);
  console.log(`Listo: ${DEMO_USER.email} / ${DEMO_USER.password}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
