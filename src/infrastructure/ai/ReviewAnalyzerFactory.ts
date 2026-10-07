import type { AppConfig } from '../../config/env.js';
import type { ReviewAnalyzer } from '../../domain/ports/ReviewAnalyzer.js';
import type { Logger } from '../../domain/ports/Services.js';
import { ClaudeReviewAnalyzer } from './ClaudeReviewAnalyzer.js';
import { HeuristicReviewAnalyzer } from './HeuristicReviewAnalyzer.js';

/**
 * Patrón Factory: decide qué estrategia de IA usar según la configuración.
 *  - AI_PROVIDER=claude    → exige ANTHROPIC_API_KEY.
 *  - AI_PROVIDER=heuristic → siempre el léxico local.
 *  - AI_PROVIDER=auto      → Claude si hay clave; si no, el léxico (con aviso en el log).
 */
export function createReviewAnalyzer(config: AppConfig, logger: Logger): ReviewAnalyzer {
  const key = config.anthropicApiKey;

  if (config.AI_PROVIDER === 'heuristic') return new HeuristicReviewAnalyzer();

  if (config.AI_PROVIDER === 'claude' && !key) {
    throw new Error('AI_PROVIDER=claude requiere ANTHROPIC_API_KEY');
  }

  if (key) return new ClaudeReviewAnalyzer(key, config.CLAUDE_MODEL, logger);

  logger.warn('ANTHROPIC_API_KEY no configurada: se usará el analizador heurístico local');
  return new HeuristicReviewAnalyzer();
}
