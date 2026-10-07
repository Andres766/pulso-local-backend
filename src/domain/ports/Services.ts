/** Puertos de servicios técnicos que el dominio/aplicación necesitan sin conocer su implementación. */

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface TokenPayload {
  sub: string;
  email: string;
}

export interface TokenService {
  sign(payload: TokenPayload): string;
  /** Devuelve null si el token es inválido, está vencido o fue manipulado. */
  verify(token: string): TokenPayload | null;
}

/** Ejecuta trabajo en segundo plano (hoy en memoria; mañana podría ser BullMQ/Redis). */
export interface TaskScheduler {
  schedule(name: string, task: () => Promise<void>): void;
}

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}
