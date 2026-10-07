/**
 * Jerarquía de errores del dominio. La capa HTTP traduce cada tipo a un código
 * de estado, así el dominio no sabe nada de HTTP (inversión de dependencias).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Una regla de negocio o un dato de entrada no es válido. */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}

/** El recurso no existe (o no pertenece al usuario: no revelamos cuál de los dos). */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
}

/** El estado actual no permite la operación (p. ej. analizar sin reseñas). */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
}

/**
 * Falla del motor de IA. El mensaje está pensado para mostrarse al dueño del negocio,
 * por eso la infraestructura nunca pone aquí detalles técnicos (claves, trazas, payloads).
 */
export class AnalyzerError extends DomainError {
  readonly code = 'ANALYZER_ERROR';

  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Credenciales inválidas. El mensaje es genérico a propósito. */
export class AuthenticationError extends DomainError {
  readonly code = 'AUTHENTICATION_ERROR';

  constructor(message = 'Credenciales inválidas') {
    super(message);
  }
}
