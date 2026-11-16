import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BusinessCategory } from '../../domain/entities/Business.js';

/**
 * Datos de demostración compartidos por el seed (escribe directo en la base, solo en desarrollo) y
 * por `npm run demo` (carga lo mismo a través de la API pública, sirve también en producción).
 */
export const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../samples');

export const DEMO_USER = { email: 'demo@pulsolocal.co', name: 'Dueño Demo', password: 'Galeras2026Pasto' };

export const DEMO_BUSINESSES: { name: string; category: BusinessCategory; city: string; csv: string }[] = [
  { name: 'Café Galeras', category: 'cafeteria', city: 'Pasto', csv: 'resenas_cafe_galeras.csv' },
  { name: 'Restaurante El Fogón', category: 'restaurante', city: 'Pasto', csv: 'resenas_restaurante_fogon.csv' },
  { name: 'Peluquería Lunaria', category: 'belleza', city: 'Pasto', csv: 'resenas_peluqueria_lunaria.csv' },
  { name: 'Artesanías Mopa-Mopa', category: 'tienda', city: 'Pasto', csv: 'resenas_artesanias_mopa_mopa.csv' },
  { name: 'Taller Mecánico Chapal', category: 'servicios', city: 'Pasto', csv: 'resenas_taller_chapal.csv' },
];

/** Fecha que separa las dos tandas del historial de demostración (fin del 30 de septiembre de 2026). */
export const DEMO_FIRST_WAVE_CUTOFF = '30/09/2026';

/** Las fechas de los CSV de ejemplo vienen como dd/mm/aaaa. */
export function parseLocalDate(raw: unknown): Date | null {
  const [d, m, y] = String(raw).split('/').map(Number);
  return d && m && y ? new Date(y, m - 1, d) : null;
}

/** dd/mm/aaaa → fin de ese día (hora local), para comparar fechas de reseñas contra un corte. */
export function endOfLocalDay(raw: string): Date | null {
  const date = parseLocalDate(raw);
  date?.setHours(23, 59, 59, 999);
  return date;
}
