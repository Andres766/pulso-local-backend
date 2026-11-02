import type { AppConfig } from '../../config/env.js';
import type { ReviewAnalyzer } from '../../domain/ports/ReviewAnalyzer.js';
import type { Logger } from '../../domain/ports/Services.js';
import { ClaudeReviewAnalyzer } from './ClaudeReviewAnalyzer.js';
import { GeminiReviewAnalyzer } from './GeminiReviewAnalyzer.js';
import { HeuristicReviewAnalyzer } from './HeuristicReviewAnalyzer.js';

type ProviderConfig = Pick<
  AppConfig,
  'AI_PROVIDER' | 'anthropicApiKey' | 'CLAUDE_MODEL' | 'geminiApiKey' | 'GEMINI_MODEL' | 'GEMINI_FALLBACK_MODEL'
>;

/**
 * Patrón Factory: decide qué estrategia de IA usar según la configuración.
 *  - AI_PROVIDER=claude    → exige ANTHROPIC_API_KEY.
 *  - AI_PROVIDER=gemini    → exige GEMINI_API_KEY.
 *  - AI_PROVIDER=heuristic → siempre el léxico local.
 *  - AI_PROVIDER=auto      → la primera clave disponible (Claude, luego Gemini); si no hay ninguna,
 *                            el léxico local, con aviso en el log.
 */
export function createReviewAnalyzer(config: ProviderConfig, logger: Logger): ReviewAnalyzer {
  const claude = () => new ClaudeReviewAnalyzer(config.anthropicApiKey!, config.CLAUDE_MODEL, logger);
  const gemini = () => new GeminiReviewAnalyzer(config.geminiApiKey!, config.GEMINI_MODEL, config.GEMINI_FALLBACK_MODEL, logger);

  switch (config.AI_PROVIDER) {
    case 'heuristic':
      return new HeuristicReviewAnalyzer();
    case 'claude':
      if (!config.anthropicApiKey) throw new Error('AI_PROVIDER=claude requiere ANTHROPIC_API_KEY');
      return claude();
    case 'gemini':
      if (!config.geminiApiKey) throw new Error('AI_PROVIDER=gemini requiere GEMINI_API_KEY');
      return gemini();
    case 'auto':
      if (config.anthropicApiKey) return claude();
      if (config.geminiApiKey) return gemini();
      logger.warn('No hay clave de IA configurada: se usará el analizador heurístico local');
      return new HeuristicReviewAnalyzer();
  }
}
