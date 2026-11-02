import { ApiError, FinishReason } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { AnalyzerError } from '../src/domain/errors/DomainError.js';
import { UsageMeter } from '../src/domain/model/LlmUsage.js';
import { ClaudeReviewAnalyzer } from '../src/infrastructure/ai/ClaudeReviewAnalyzer.js';
import { type GeminiClient, GeminiReviewAnalyzer } from '../src/infrastructure/ai/GeminiReviewAnalyzer.js';
import { HeuristicReviewAnalyzer } from '../src/infrastructure/ai/HeuristicReviewAnalyzer.js';
import { LlmReviewAnalyzer } from '../src/infrastructure/ai/LlmReviewAnalyzer.js';
import { createReviewAnalyzer } from '../src/infrastructure/ai/ReviewAnalyzerFactory.js';
import { silentLogger } from './fakes.js';

type Reply = { text?: string; finishReason?: FinishReason; blockReason?: string } | Error;

/** Cliente de Gemini falso: devuelve respuestas programadas y registra qué modelo se pidió. */
function fakeClient(replies: Reply[]) {
  const calls: { model: string; config: Record<string, unknown> }[] = [];
  const client = {
    models: {
      generateContent: async (params: { model: string; config: Record<string, unknown> }) => {
        calls.push({ model: params.model, config: params.config });
        const next = replies.shift();
        if (!next) throw new Error('sin respuestas programadas');
        if (next instanceof Error) throw next;
        return {
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50 },
          text: next.text,
          modelVersion: params.model,
          candidates: [{ finishReason: next.finishReason ?? FinishReason.STOP }],
          promptFeedback: next.blockReason ? { blockReason: next.blockReason } : undefined,
        };
      },
    },
  } as unknown as GeminiClient;
  return { client, calls };
}

const build = (replies: Reply[]) => {
  const fake = fakeClient(replies);
  return {
    analyzer: new GeminiReviewAnalyzer('clave', 'modelo-principal', 'modelo-respaldo', silentLogger, fake.client),
    calls: fake.calls,
  };
};

const reviews = [
  { id: 'uuid-1', content: 'Se demoraron una hora', rating: 1 },
  { id: 'uuid-2', content: 'Delicioso el café', rating: 5 },
];
const topics = [{ key: 'espera', name: 'Espera', description: 'd' }];
const classification = JSON.stringify({
  results: [
    { id: 'r1', sentiment: 'negative', score: -0.9, topics: ['espera'] },
    { id: 'r2', sentiment: 'positive', score: 0.8, topics: [] },
    { id: 'r99', sentiment: 'positive', score: 1, topics: [] }, // alias que no existe en el lote
  ],
});

describe('GeminiReviewAnalyzer', () => {
  it('pide JSON con esquema y traduce los alias r1, r2… a los IDs reales', async () => {
    const { analyzer, calls } = build([{ text: classification }]);
    const result = await analyzer.classify(reviews, topics);

    expect(result.map((r) => [r.reviewId, r.sentiment.label])).toEqual([
      ['uuid-1', 'negative'],
      ['uuid-2', 'positive'],
    ]);
    expect(calls[0]!.config.responseMimeType).toBe('application/json');
    expect(calls[0]!.config.responseJsonSchema).toMatchObject({ type: 'object', required: ['results'] });
    expect(analyzer.providerName).toBe('gemini:modelo-principal');
  });

  it('anota en el medidor los tokens de entrada y de salida (incluido el razonamiento)', async () => {
    const { analyzer } = build([{ text: classification }]);
    const meter = new UsageMeter();
    await analyzer.classify(reviews, topics, meter);
    expect(meter.total).toEqual({ calls: 1, inputTokens: 1000, outputTokens: 250 });
  });

  it('si el modelo principal está saturado (503), usa el de respaldo', async () => {
    const { analyzer, calls } = build([new ApiError({ message: 'high demand', status: 503 }), { text: classification }]);
    const result = await analyzer.classify(reviews, topics);
    expect(result).toHaveLength(2);
    expect(calls.map((c) => c.model)).toEqual(['modelo-principal', 'modelo-respaldo']);
  });

  it('traduce errores a mensajes para el usuario, sin detalles técnicos', async () => {
    const quota = build([new ApiError({ message: 'quota', status: 429 }), new ApiError({ message: 'quota', status: 429 })]);
    await expect(quota.analyzer.classify(reviews, topics)).rejects.toThrow(/límite gratuito/);

    const badKey = build([new ApiError({ message: 'API key not valid. Please pass a valid API key.', status: 400 })]);
    const err = await badKey.analyzer.classify(reviews, topics).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerError);
    expect((err as Error).message).toMatch(/credencial/);
    expect(badKey.calls).toHaveLength(1); // un error de credencial no se reintenta con otro modelo
  });

  it('rechaza respuestas bloqueadas, cortadas o que no cumplen el esquema', async () => {
    await expect(build([{ blockReason: 'SAFETY' }]).analyzer.classify(reviews, topics)).rejects.toThrow(/no pudo procesar/);
    await expect(
      build([{ text: '{"results":[', finishReason: FinishReason.MAX_TOKENS }]).analyzer.classify(reviews, topics),
    ).rejects.toThrow(/incompleta/);
    await expect(build([{ text: '{"results":[{"id":"r1","sentiment":"feliz"}]}' }]).analyzer.classify(reviews, topics)).rejects.toThrow(
      /formato inesperado/,
    );
    await expect(build([{ text: 'esto no es JSON' }]).analyzer.classify(reviews, topics)).rejects.toThrow(/formato inesperado/);
  });
});

describe('createReviewAnalyzer (Factory)', () => {
  const base = {
    AI_PROVIDER: 'auto' as const,
    anthropicApiKey: undefined as string | undefined,
    CLAUDE_MODEL: 'claude-opus-5',
    geminiApiKey: undefined as string | undefined,
    GEMINI_MODEL: 'gemini-3.5-flash',
    GEMINI_FALLBACK_MODEL: 'gemini-flash-lite-latest',
  };

  it('en modo auto elige según las claves disponibles', () => {
    expect(createReviewAnalyzer(base, silentLogger)).toBeInstanceOf(HeuristicReviewAnalyzer);
    expect(createReviewAnalyzer({ ...base, geminiApiKey: 'g' }, silentLogger)).toBeInstanceOf(GeminiReviewAnalyzer);
    expect(createReviewAnalyzer({ ...base, geminiApiKey: 'g', anthropicApiKey: 'a' }, silentLogger)).toBeInstanceOf(ClaudeReviewAnalyzer);
  });

  it('los proveedores LLM comparten la clase base (Template Method)', () => {
    expect(createReviewAnalyzer({ ...base, geminiApiKey: 'g' }, silentLogger)).toBeInstanceOf(LlmReviewAnalyzer);
    expect(createReviewAnalyzer({ ...base, anthropicApiKey: 'a' }, silentLogger)).toBeInstanceOf(LlmReviewAnalyzer);
  });

  it('exige la clave cuando el proveedor se fuerza', () => {
    expect(() => createReviewAnalyzer({ ...base, AI_PROVIDER: 'gemini' }, silentLogger)).toThrow(/GEMINI_API_KEY/);
    expect(() => createReviewAnalyzer({ ...base, AI_PROVIDER: 'claude' }, silentLogger)).toThrow(/ANTHROPIC_API_KEY/);
    expect(createReviewAnalyzer({ ...base, AI_PROVIDER: 'heuristic', geminiApiKey: 'g' }, silentLogger)).toBeInstanceOf(
      HeuristicReviewAnalyzer,
    );
  });
});
