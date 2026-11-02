import { describe, expect, it } from 'vitest';
import type { AnalysisWorker } from '../../src/application/use-cases/analysis/AnalysisWorker.js';
import { PollingJobRunner } from '../../src/infrastructure/jobs/PollingJobRunner.js';
import { silentLogger } from '../fakes.js';

/** Worker falso: cada drain() tarda lo que diga `release` y cuenta cuántas pasadas se solaparon. */
function fakeWorker() {
  let active = 0;
  const state = { drains: 0, maxConcurrent: 0, release: null as (() => void) | null };
  const worker = {
    drain: async () => {
      state.drains++;
      active++;
      state.maxConcurrent = Math.max(state.maxConcurrent, active);
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      active--;
      return 0;
    },
  } as unknown as AnalysisWorker;
  return { worker, state };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('PollingJobRunner', () => {
  it('al arrancar revisa la cola y un aviso durante una pasada provoca una pasada más, sin solaparse', async () => {
    const { worker, state } = fakeWorker();
    const runner = new PollingJobRunner(worker, silentLogger, 60_000);
    runner.start();
    await tick();
    expect(state.drains).toBe(1);

    runner.wake(); // llega trabajo mientras la primera pasada sigue en curso
    runner.wake();
    state.release!();
    await tick();
    expect(state.drains).toBe(2); // los dos avisos se agrupan en una sola pasada extra
    expect(state.maxConcurrent).toBe(1);

    state.release!();
    await runner.stop();
  });

  it('stop() espera a que termine la pasada en curso y luego ignora los avisos', async () => {
    const { worker, state } = fakeWorker();
    const runner = new PollingJobRunner(worker, silentLogger, 60_000);
    runner.start();
    await tick();

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(false); // todavía hay un análisis corriendo
    state.release!();
    await stopping;
    expect(stopped).toBe(true);

    runner.wake();
    await tick();
    expect(state.drains).toBe(1);
  });
});
