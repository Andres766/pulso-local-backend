import { describe, expect, it } from 'vitest';
import { UsageMeter } from '../../src/domain/model/LlmUsage.js';

describe('UsageMeter', () => {
  it('acumula llamadas y tokens, e ignora valores ausentes o negativos', () => {
    const meter = new UsageMeter();
    meter.record(1200, 300);
    meter.record(undefined, 50);
    meter.record(-5, 10.6);
    expect(meter.total).toEqual({ calls: 3, inputTokens: 1200, outputTokens: 361 });
  });
});
