import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { AnalyzerError } from '../../domain/errors/DomainError.js';
import type { Logger } from '../../domain/ports/Services.js';
import { type Effort, LlmReviewAnalyzer } from './LlmReviewAnalyzer.js';
import { SYSTEM_PROMPT } from './prompts.js';

/** Lo único que este adaptador usa del SDK: permite inyectar un cliente falso en las pruebas. */
export type GeminiClient = Pick<GoogleGenAI, 'models'>;

const THINKING: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** Errores transitorios (saturación, cuota, caídas): tras los reintentos se prueba el modelo de respaldo. */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Adaptador entre el puerto ReviewAnalyzer y la API de Gemini (Google). Toda la dependencia del
 * SDK @google/genai vive aquí. Hereda de LlmReviewAnalyzer los prompts y la traducción al dominio;
 * solo implementa cómo llamar a la API.
 *
 * El plan gratuito a veces responde 503 ("alta demanda") o 429 (cuota): el SDK reintenta con
 * espera exponencial y, si el modelo principal sigue sin responder, se usa el modelo de respaldo.
 */
export class GeminiReviewAnalyzer extends LlmReviewAnalyzer {
  private readonly client: GeminiClient;
  private readonly models: string[];

  constructor(
    apiKey: string,
    private readonly model: string,
    fallbackModel: string | undefined,
    private readonly logger: Logger,
    client?: GeminiClient,
  ) {
    super();
    this.models = [...new Set([model, fallbackModel].filter((m): m is string => Boolean(m)))];
    this.client =
      client ??
      new GoogleGenAI({
        apiKey,
        httpOptions: {
          timeout: 120_000,
          retryOptions: { attempts: 3, initialDelay: 2, maxDelay: 20, httpStatusCodes: [...TRANSIENT] },
        },
      });
  }

  get providerName(): string {
    return `gemini:${this.model}`;
  }

  protected async generate<T extends z.ZodType>(prompt: string, schema: T, effort: Effort, step: string): Promise<z.infer<T>> {
    let lastError: unknown;
    for (const model of this.models) {
      try {
        return await this.call(model, prompt, schema, effort, step);
      } catch (err) {
        lastError = err;
        const transient = err instanceof ApiError && (TRANSIENT.has(err.status) || err.status === 404);
        if (!transient || model === this.models.at(-1)) break;
        this.logger.warn({ step, model, status: (err as ApiError).status }, 'Gemini no respondió; se usa el modelo de respaldo');
      }
    }
    if (!(lastError instanceof AnalyzerError)) this.logger.warn({ err: lastError, step }, 'Fallo llamando a Gemini');
    throw GeminiReviewAnalyzer.translate(lastError, step);
  }

  private async call<T extends z.ZodType>(model: string, prompt: string, schema: T, effort: Effort, step: string): Promise<z.infer<T>> {
    const response = await this.client.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // Salida estructurada: el modelo queda restringido al esquema JSON derivado del esquema Zod.
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(schema),
        thinkingConfig: { thinkingLevel: THINKING[effort] },
        maxOutputTokens: 16_000,
      },
    });

    const candidate = response.candidates?.[0];
    this.logger.info(
      { step, model, served: response.modelVersion, finish: candidate?.finishReason, usage: response.usageMetadata },
      'Respuesta de Gemini',
    );

    if (
      response.promptFeedback?.blockReason ||
      candidate?.finishReason === FinishReason.SAFETY ||
      candidate?.finishReason === FinishReason.PROHIBITED_CONTENT
    ) {
      throw new AnalyzerError('La IA no pudo procesar estas reseñas. Revisa que el contenido sea apropiado.');
    }
    if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
      throw new AnalyzerError('La respuesta de la IA quedó incompleta. Intenta con menos reseñas.', true);
    }

    // Defensa en profundidad: aunque la API respete el esquema, la salida se vuelve a validar con Zod.
    const parsed = schema.safeParse(GeminiReviewAnalyzer.parseJson(response.text));
    if (!parsed.success) {
      throw new AnalyzerError('La IA devolvió una respuesta con formato inesperado. Intenta de nuevo.', true);
    }
    return parsed.data;
  }

  private static parseJson(text: string | undefined): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Traduce errores del SDK a errores del dominio con mensajes aptos para el usuario. */
  private static translate(err: unknown, step: string): AnalyzerError {
    if (err instanceof AnalyzerError) return err;
    if (err instanceof ApiError) {
      if (err.status === 400 && /api key/i.test(err.message))
        return new AnalyzerError('La credencial del servicio de IA no es válida. Contacta al administrador.');
      if (err.status === 401 || err.status === 403)
        return new AnalyzerError('La credencial del servicio de IA no es válida. Contacta al administrador.');
      if (err.status === 404) return new AnalyzerError('El modelo de IA configurado no está disponible.');
      if (err.status === 429)
        return new AnalyzerError('Se alcanzó el límite gratuito del servicio de IA. Intenta de nuevo en unos minutos.', true);
      if (TRANSIENT.has(err.status)) return new AnalyzerError('El servicio de IA está saturado. Intenta de nuevo en unos minutos.', true);
      return new AnalyzerError(`El servicio de IA falló al ${step}. Intenta de nuevo.`);
    }
    return new AnalyzerError(`Error inesperado al ${step}.`);
  }
}
