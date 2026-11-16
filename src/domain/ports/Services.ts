import type { AnalysisRun } from '../entities/AnalysisRun.js';

/** Puertos de servicios técnicos que el dominio/aplicación necesitan sin conocer su implementación. */

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface TokenPayload {
  sub: string;
  email: string;
  /** Versión de sesión del usuario al emitir el token; si cambia (p. ej. nueva contraseña), el token deja de valer. */
  ver: number;
}

/** Comprueba contra el estado actual del usuario que un token (ya verificado criptográficamente) siga vigente. */
export interface SessionValidator {
  isValid(payload: TokenPayload): Promise<boolean>;
}

export interface TokenService {
  sign(payload: TokenPayload): string;
  /** Devuelve null si el token es inválido, está vencido o fue manipulado. */
  verify(token: string): TokenPayload | null;
}

/**
 * Cola de trabajos en segundo plano. Los trabajos ya están persistidos (análisis "pending" en la
 * base de datos); wake() solo avisa al worker para que no espere al siguiente sondeo.
 */
export interface JobQueue {
  wake(): void;
}

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/** Un análisis cambió de estado (en cola, en curso, reintentando, completado o fallido). */
export interface AnalysisEvent {
  businessId: string;
  run: ReturnType<AnalysisRun['toJSON']>;
}

/**
 * Puerto de salida para avisar en tiempo real (patrón Observer / Pub-Sub). La aplicación solo
 * publica; quién escucha (WebSockets, otras instancias del servidor) lo decide la infraestructura.
 */
export interface AnalysisEventPublisher {
  publish(event: AnalysisEvent): void;
}
