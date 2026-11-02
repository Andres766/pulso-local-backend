import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisRun, MAX_ANALYSIS_ATTEMPTS } from '../../src/domain/entities/AnalysisRun.js';
import { Business } from '../../src/domain/entities/Business.js';
import { Review } from '../../src/domain/entities/Review.js';
import { User } from '../../src/domain/entities/User.js';
import { Email } from '../../src/domain/value-objects/Email.js';
import { Rating } from '../../src/domain/value-objects/Rating.js';
import { Sentiment } from '../../src/domain/value-objects/Sentiment.js';
import { Database } from '../../src/infrastructure/db/Database.js';
import { runMigrations } from '../../src/infrastructure/db/migrate.js';
import { PgAnalysisRepository } from '../../src/infrastructure/db/repositories/PgAnalysisRepository.js';
import { PgBusinessRepository } from '../../src/infrastructure/db/repositories/PgBusinessRepository.js';
import { PgReviewRepository } from '../../src/infrastructure/db/repositories/PgReviewRepository.js';
import { PgUserRepository } from '../../src/infrastructure/db/repositories/PgUserRepository.js';

/**
 * Pruebas de integración de los repositorios contra un PostgreSQL real: ejercitan el SQL que las
 * pruebas en memoria no ven (UNNEST, FOR UPDATE SKIP LOCKED, cascadas, count(*) FILTER).
 *
 * Solo corren si existe TEST_DATABASE_URL, y por seguridad el nombre de la base debe terminar en
 * "_test": antes de cada archivo se borra el esquema completo.
 *   TEST_DATABASE_URL=postgres://pulso:...@localhost:5434/pulsolocal_test npm test
 */
const url = process.env.TEST_DATABASE_URL;
const dbName = url ? new URL(url).pathname.slice(1) : '';
if (url && !dbName.endsWith('_test')) {
  throw new Error(`TEST_DATABASE_URL debe apuntar a una base *_test (recibido "${dbName}"): estas pruebas borran el esquema.`);
}

describe.skipIf(!url)('Repositorios PostgreSQL', () => {
  let db: Database;
  let users: PgUserRepository;
  let businesses: PgBusinessRepository;
  let reviews: PgReviewRepository;
  let analyses: PgAnalysisRepository;
  let owner: User;
  let business: Business;

  beforeAll(async () => {
    db = new Database(url!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    expect(await runMigrations(db)).toHaveLength(4);
    users = new PgUserRepository(db);
    businesses = new PgBusinessRepository(db);
    reviews = new PgReviewRepository(db);
    analyses = new PgAnalysisRepository(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE users CASCADE');
    owner = User.register({ email: Email.create(`dueno-${Date.now()}@cafe.co`), name: 'Dueño', passwordHash: 'hash' });
    await users.save(owner);
    business = Business.create({ ownerId: owner.id, name: 'Café Galeras', category: 'cafeteria', city: 'Pasto' });
    await businesses.save(business);
  });

  const review = (content: string, rating: number | null, day: number) =>
    Review.create({
      businessId: business.id,
      content,
      rating: rating ? Rating.create(rating) : null,
      source: 'csv',
      authoredAt: new Date(2026, 8, day),
    });

  it('las migraciones son idempotentes', async () => {
    expect(await runMigrations(db)).toEqual([]);
  });

  it('el usuario persiste bloqueo y versión de sesión', async () => {
    for (let i = 0; i < 5; i++) owner.registerFailedLogin();
    owner.changePassword('otro-hash');
    await users.save(owner);
    const loaded = (await users.findByEmail(owner.email))!;
    expect(loaded.tokenVersion).toBe(1);
    expect(loaded.passwordHash).toBe('otro-hash');
    expect(loaded.isLocked()).toBe(false); // cambiar la contraseña quita el bloqueo
  });

  it('saveMany ignora duplicados por huella y search filtra, ordena y escapa comodines', async () => {
    const inserted = await reviews.saveMany([
      review('Pan duro', 1, 1),
      review('Pan delicioso', 5, 2),
      review('  PAN   duro ', 1, 3),
      review('100% recomendado', 4, 4),
    ]);
    expect(inserted).toBe(3);

    const byRating = await reviews.search(business.id, { limit: 10, offset: 0, sort: 'rating_desc' });
    expect(byRating.items.map((i) => i.review.rating?.value)).toEqual([5, 4, 1]);
    expect((await reviews.search(business.id, { limit: 10, offset: 0, rating: 1 })).total).toBe(1);
    expect((await reviews.search(business.id, { limit: 10, offset: 0, search: '%' })).items.map((i) => i.review.content)).toEqual([
      '100% recomendado',
    ]);
    expect((await reviews.search(business.id, { limit: 10, offset: 0, sort: 'oldest' })).items[0]!.review.content).toBe('Pan duro');
  });

  it('deleteOne solo borra reseñas del negocio indicado', async () => {
    const r = review('Spam', null, 5);
    await reviews.saveMany([r]);
    const other = Business.create({ ownerId: owner.id, name: 'Otro', category: 'otro' });
    await businesses.save(other);
    expect(await reviews.deleteOne(other.id, r.id)).toBe(false);
    expect(await reviews.deleteOne(business.id, r.id)).toBe(true);
  });

  it('claimNext nunca entrega el mismo análisis a dos workers concurrentes', async () => {
    const runs = [1, 2, 3].map(() => AnalysisRun.request({ businessId: business.id, provider: 'test', reviewCount: 1 }));
    for (const r of runs) await analyses.save(r);

    const claimed = await Promise.all([analyses.claimNext(), analyses.claimNext(), analyses.claimNext(), analyses.claimNext()]);
    const ids = claimed.filter(Boolean).map((r) => r!.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(claimed.every((r) => !r || (r.status === 'running' && r.attempts === 1))).toBe(true);
  });

  it('recoverInterrupted devuelve a la cola o falla según los intentos restantes', async () => {
    const retry = AnalysisRun.request({ businessId: business.id, provider: 'test', reviewCount: 1 });
    const exhausted = AnalysisRun.restore({
      ...retry.toJSON(),
      id: crypto.randomUUID(),
      businessId: business.id,
      status: 'running',
      attempts: MAX_ANALYSIS_ATTEMPTS,
      availableAt: new Date(),
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
    });
    await analyses.save(retry);
    await analyses.claimNext();
    await analyses.save(exhausted);

    expect(await analyses.recoverInterrupted('Reinicio')).toEqual({ requeued: 1, failed: 1 });
    expect((await analyses.findById(retry.id))!.status).toBe('pending');
    expect((await analyses.findById(exhausted.id))!.status).toBe('failed');
  });

  it('completeWithResults guarda todo en una transacción y getReport/sentimentByMonth lo leen', async () => {
    const [a, b] = [review('Lento', 2, 10), review('Rico', 5, 20)];
    await reviews.saveMany([a, b]);
    const run = AnalysisRun.request({ businessId: business.id, provider: 'test', reviewCount: 2 });
    await analyses.save(run);
    const claimed = (await analyses.claimNext())!;
    claimed.complete();
    const topic = {
      key: 'espera',
      name: 'Espera',
      description: 'd',
      mentions: 1,
      share: 50,
      positive: 0,
      neutral: 0,
      negative: 1,
      complaintShare: 50,
      sampleQuotes: ['Lento'],
    };
    await analyses.completeWithResults(claimed, {
      classifications: [
        { reviewId: a.id, sentiment: Sentiment.of('negative', -0.7), topicKeys: ['espera'] },
        { reviewId: b.id, sentiment: Sentiment.of('positive', 0.9), topicKeys: [] },
      ],
      topics: [topic],
      recommendations: [{ rank: 1, title: 'Reduce la espera', detail: 'd', priority: 'alta', topicKey: 'espera', evidenceShare: 50 }],
      sentiment: { positive: 1, neutral: 0, negative: 1, averageScore: 0.1 },
    });

    const report = (await analyses.getReport(claimed.id))!;
    expect(report.stats.topics[0]).toMatchObject({ key: 'espera', sampleQuotes: ['Lento'] });
    expect(report.recommendations[0]).toMatchObject({ topicKey: 'espera', evidenceShare: 50 });
    expect((await reviews.search(business.id, { limit: 10, offset: 0, sort: 'most_negative' })).items[0]).toMatchObject({
      sentiment: 'negative',
      topics: ['Espera'],
    });

    const months = await analyses.sentimentByMonth(claimed.id, 24);
    expect(months).toEqual([{ month: '2026-09', positive: 1, neutral: 0, negative: 1, total: 2, averageScore: 0.1 }]);
  });

  it('borrar el usuario elimina en cascada negocios, reseñas y análisis', async () => {
    await reviews.saveMany([review('Algo', 3, 1)]);
    await analyses.save(AnalysisRun.request({ businessId: business.id, provider: 'test', reviewCount: 1 }));
    await users.delete(owner.id);
    const counts = await db.query<{ b: string; r: string; a: string }>(
      'SELECT (SELECT count(*) FROM businesses) AS b, (SELECT count(*) FROM reviews) AS r, (SELECT count(*) FROM analysis_runs) AS a',
    );
    expect(counts.rows[0]).toEqual({ b: '0', r: '0', a: '0' });
  });
});
