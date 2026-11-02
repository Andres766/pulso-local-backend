import { readFileSync } from 'node:fs';

/**
 * Versión de la aplicación según package.json. Se resuelve relativa a este archivo, así funciona
 * igual en desarrollo (src/config) y en la imagen de Docker (dist/config): ambos están a dos
 * niveles de la raíz donde vive package.json.
 */
export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'desconocida';
  } catch {
    return 'desconocida';
  }
}
