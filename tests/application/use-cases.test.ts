import { beforeEach, describe, expect, it } from 'vitest';
import { ExecuteAnalysis } from '../../src/application/use-cases/analysis/ExecuteAnalysis.js';
import { RequestAnalysis } from '../../src/application/use-cases/analysis/RequestAnalysis.js';
import { AuthenticateUser } from '../../src/application/use-cases/auth/AuthenticateUser.js';
import { RegisterUser } from '../../src/application/use-cases/auth/RegisterUser.js';
import { BusinessAccess } from '../../src/application/use-cases/businesses/BusinessAccess.js';
import { CreateBusiness } from '../../src/application/use-cases/businesses/BusinessUseCases.js';
import { ImportReviews } from '../../src/application/use-cases/reviews/ReviewUseCases.js';
import {
  AnalyzerError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../src/domain/errors/DomainError.js';
import type { ReviewAnalyzer } from '../../src/domain/ports/ReviewAnalyzer.js';
import { InsightAggregator } from '../../src/domain/services/InsightAggregator.js';
import { Sentiment } from '../../src/domain/value-objects/Sentiment.js';
import { HeuristicReviewAnalyzer } from '../../src/infrastructure/ai/HeuristicReviewAnalyzer.js';
import {
  FakeHasher,
  FakeTokens,
  ImmediateScheduler,
  InMemoryAnalyses,
  InMemoryBusinesses,
  InMemoryReviews,
  InMemoryUsers,
  silentLogger,
} from '../fakes.js';

describe('Autenticación', () => {
  const users = new InMemoryUsers();
  const hasher = new FakeHasher();
  const register = new RegisterUser(users, hasher);
  const login = new AuthenticateUser(users, hasher, new FakeTokens());

  it('registra y autentica con la contraseña correcta', async () => {
    await register.execute({ email: 'ana@cafe.co', name: 'Ana', password: 'cafeteria2026' });
    const { user, token } = await login.execute({ email: 'ANA@cafe.co', password: 'cafeteria2026' });
    expect(user.name).toBe('Ana');
    expect(token).toBe(`token:${user.id}`);
  });

  it('usa el mismo error para correo inexistente y contraseña errada', async () => {
    await expect(login.execute({ email: 'ana@cafe.co', password: 'otra-clave-99' })).rejects.toThrow(AuthenticationError);
    await expect(login.execute({ email: 'nadie@cafe.co', password: 'cafeteria2026' })).rejects.toThrow(AuthenticationError);
  });

  it('exige contraseñas robustas y correos únicos', async () => {
    await expect(register.execute({ email: 'b@c.co', name: 'Bo', password: 'corta1' })).rejects.toThrow(ValidationError);
    await expect(register.execute({ email: 'b@c.co', name: 'Bo', password: 'soloLetrasLargas' })).rejects.toThrow(ValidationError);
    await expect(register.execute({ email: 'ana@cafe.co', name: 'Ana', password: 'cafeteria2026' })).rejects.toThrow(ConflictError);
  });
});

describe('Importación y análisis', () => {
  let businesses: InMemoryBusinesses;
  let reviews: InMemoryReviews;
  let analyses: InMemoryAnalyses;
  let scheduler: ImmediateScheduler;
  let businessId: string;

  const build = (analyzer: ReviewAnalyzer) => {
    const access = new BusinessAccess(businesses);
    const execute = new ExecuteAnalysis(analyses, businesses, reviews, analyzer, new InsightAggregator(), silentLogger, 500);
    return {
      importReviews: new ImportReviews(access, reviews),
      requestAnalysis: new RequestAnalysis(access, reviews, analyses, analyzer, scheduler, execute),
    };
  };

  beforeEach(async () => {
    businesses = new InMemoryBusinesses();
    reviews = new InMemoryReviews();
    analyses = new InMemoryAnalyses();
    scheduler = new ImmediateScheduler();
    businessId = (await new CreateBusiness(businesses).execute('owner', { name: 'Café Galeras', category: 'cafeteria' })).id;
  });

  it('importa, descarta duplicados y reporta filas inválidas', async () => {
    const { importReviews } = build(new HeuristicReviewAnalyzer());
    const summary = await importReviews.execute(
      businessId,
      'owner',
      [{ content: 'El café delicioso' }, { content: '  el CAFÉ delicioso ' }, { content: '' }, { content: 'Atención lenta', rating: '2' }],
      'csv',
    );
    expect(summary).toMatchObject({ received: 4, imported: 2, duplicates: 1 });
    expect(summary.rejected).toEqual([{ row: 3, reason: 'La reseña es demasiado corta' }]);
  });

  it('otro usuario no puede cargar reseñas en un negocio ajeno (IDOR)', async () => {
    const { importReviews } = build(new HeuristicReviewAnalyzer());
    await expect(importReviews.execute(businessId, 'intruso', [{ content: 'spam spam' }], 'manual')).rejects.toThrow(NotFoundError);
  });

  it('ejecuta el pipeline completo con el analizador heurístico', async () => {
    const { importReviews, requestAnalysis } = build(new HeuristicReviewAnalyzer());
    await importReviews.execute(
      businessId,
      'owner',
      [
        { content: 'Se demoraron muchísimo, esperé 40 minutos por un tinto', rating: 1 },
        { content: 'Muy lento el servicio y la mesera fue grosera', rating: 2 },
        { content: 'El café es delicioso y el lugar muy acogedor', rating: 5 },
        { content: 'Buen sabor pero demasiado caro para la porción', rating: 3 },
      ],
      'csv',
    );

    const run = await requestAnalysis.execute(businessId, 'owner');
    await scheduler.flush();

    const stored = await analyses.findById(run.id);
    expect(stored?.status).toBe('completed');
    const report = await analyses.getReport(run.id);
    expect(report!.stats.totalReviews).toBe(4);
    expect(report!.stats.topics.find((t) => t.key === 'tiempo_espera')?.negative).toBe(2);
    expect(report!.recommendations.length).toBeGreaterThan(0);
    expect(report!.recommendations[0]!.evidenceShare).not.toBeNull();
  });

  it('no permite analizar sin reseñas ni lanzar dos análisis a la vez', async () => {
    const slow: ReviewAnalyzer = {
      providerName: 'lento',
      batchSize: 10,
      discoverTopics: () => new Promise(() => {}), // nunca termina
      classify: async () => [],
      recommend: async () => [],
    };
    const { importReviews, requestAnalysis } = build(slow);
    await expect(requestAnalysis.execute(businessId, 'owner')).rejects.toThrow(ConflictError);

    await importReviews.execute(businessId, 'owner', [{ content: 'Todo bien' }], 'manual');
    await requestAnalysis.execute(businessId, 'owner');
    await expect(requestAnalysis.execute(businessId, 'owner')).rejects.toThrow(ConflictError);
  });

  it('si la IA falla, el análisis queda "failed" con un mensaje apto para el usuario', async () => {
    const broken: ReviewAnalyzer = {
      providerName: 'roto',
      batchSize: 10,
      discoverTopics: async () => {
        throw new AnalyzerError('El servicio de IA está ocupado.', true);
      },
      classify: async () => [],
      recommend: async () => [],
    };
    const { importReviews, requestAnalysis } = build(broken);
    await importReviews.execute(businessId, 'owner', [{ content: 'Todo bien' }], 'manual');
    const run = await requestAnalysis.execute(businessId, 'owner');
    await scheduler.flush();

    const stored = await analyses.findById(run.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('El servicio de IA está ocupado.');
  });

  it('descarta IDs y temas que el modelo invente', async () => {
    const hallucinating: ReviewAnalyzer = {
      providerName: 'alucina',
      batchSize: 10,
      discoverTopics: async () => [{ key: 'Tiempo de Espera', name: 'Espera', description: 'd' }],
      classify: async (batch) => [
        ...batch.map((r) => ({ reviewId: r.id, sentiment: Sentiment.of('negative', -0.5), topicKeys: ['tiempo_de_espera', 'inventado'] })),
        { reviewId: 'id-que-no-existe', sentiment: Sentiment.of('negative', -1), topicKeys: [] },
      ],
      recommend: async () => [],
    };
    const { importReviews, requestAnalysis } = build(hallucinating);
    await importReviews.execute(businessId, 'owner', [{ content: 'Demasiada espera' }], 'manual');
    const run = await requestAnalysis.execute(businessId, 'owner');
    await scheduler.flush();

    const results = analyses.results.get(run.id)!;
    expect(results.classifications).toHaveLength(1);
    expect(results.classifications[0]!.topicKeys).toEqual(['tiempo_de_espera']);
  });
});
