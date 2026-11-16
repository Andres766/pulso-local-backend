import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisEvent } from '../../src/domain/ports/Services.js';
import { Database } from '../../src/infrastructure/db/Database.js';
import { PgNotifyRealtimeBus } from '../../src/infrastructure/realtime/PgNotifyRealtimeBus.js';
import { silentLogger } from '../fakes.js';

/**
 * Backplane contra PostgreSQL real: dos buses con conexiones distintas hacen de dos instancias del
 * servidor. Lo que publica una debe llegarle a la otra (escalado horizontal con Pub/Sub).
 * Solo corre con TEST_DATABASE_URL (ver repositories.db.test.ts); no escribe tablas.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Backplane LISTEN/NOTIFY', () => {
  let dbA: Database;
  let dbB: Database;
  let serverA: PgNotifyRealtimeBus;
  let serverB: PgNotifyRealtimeBus;
  const receivedByB: AnalysisEvent[] = [];

  beforeAll(async () => {
    dbA = new Database(url!);
    dbB = new Database(url!);
    serverA = new PgNotifyRealtimeBus(url!, dbA, silentLogger);
    serverB = new PgNotifyRealtimeBus(url!, dbB, silentLogger);
    serverB.subscribe((event) => receivedByB.push(event));
    await Promise.all([serverA.start(), serverB.start()]);
  });

  afterAll(async () => {
    await Promise.all([serverA.stop(), serverB.stop()]);
    await Promise.all([dbA.close(), dbB.close()]);
  });

  it('un evento publicado en la instancia A llega a la instancia B', async () => {
    const event = {
      businessId: '7f1c2d3e-0000-4000-8000-000000000001',
      run: { id: 'run-1', status: 'completed', reviewCount: 3 },
    } as unknown as AnalysisEvent;
    serverA.publish(event);

    const deadline = Date.now() + 3000;
    while (receivedByB.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(receivedByB).toEqual([event]);
  });
});
