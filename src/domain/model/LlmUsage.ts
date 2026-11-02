/** Consumo de un modelo de lenguaje: cuántas llamadas y cuántos tokens de entrada y salida. */
export interface LlmUsage {
  calls: number;
  inputTokens: number;
  /** Incluye los tokens de razonamiento (thinking), que también se cobran como salida. */
  outputTokens: number;
}

export const ZERO_USAGE: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

export const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  calls: a.calls + b.calls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/**
 * Acumulador de consumo para UN análisis. El caso de uso crea uno por ejecución y lo pasa al
 * proveedor de IA, que anota cada respuesta; así los análisis concurrentes no se mezclan aunque
 * compartan la misma instancia del analizador.
 */
export class UsageMeter {
  private usage: LlmUsage = ZERO_USAGE;

  record(inputTokens: number | undefined, outputTokens: number | undefined): void {
    this.usage = addUsage(this.usage, {
      calls: 1,
      inputTokens: Math.max(0, Math.round(inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.round(outputTokens ?? 0)),
    });
  }

  get total(): LlmUsage {
    return this.usage;
  }
}
