import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetDashboard } from '../../src/application/use-cases/analysis/AnalysisQueries.js';
import { AnalysisWorker } from '../../src/application/use-cases/analysis/AnalysisWorker.js';
import { ExecuteAnalysis, RETRY_BASE_DELAY_MS } from '../../src/application/use-cases/analysis/ExecuteAnalysis.js';
import { RequestAnalysis } from '../../src/application/use-cases/analysis/RequestAnalysis.js';
import { AuthenticateUser } from '../../src/application/use-cases/auth/AuthenticateUser.js';
import { RegisterUser } from '../../src/application/use-cases/auth/RegisterUser.js';
import { BusinessAccess } from '../../src/application/use-cases/businesses/BusinessAccess.js';
import { CreateBusiness } from '../../src/application/use-cases/businesses/BusinessUseCases.js';
import { ImportReviews } from '../../src/application/use-cases/reviews/ReviewUseCases.js';
import { AnalyzerError, AuthenticationError, ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors/DomainError.js';
import type { ReviewAnalyzer } from '../../src/domain/ports/ReviewAnalyzer.js';
import { InsightAggregator } from '../../src/domain/services/InsightAggregator.js';
import { InsightComparator } from '../../src/domain/services/InsightComparator.js';
import { Sentiment } from '../../src/domain/value-objects/Sentiment.js';
import { HeuristicReviewAnalyzer } from '../../src/infrastructure/ai/HeuristicReviewAnalyzer.js';
import {
  FakeHasher,
  FakeTokens,
  InMemoryAnalyses,
  InMemoryBusinesses,
  InMemoryReviews,
  InMemoryUsers,
  ManualQueue,
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
  let queue: ManualQueue;
  let businessId: string;

  const build = (analyzer: ReviewAnalyzer) => {
    const access = new BusinessAccess(businesses);
    const execute = new ExecuteAnalysis(analyses, businesses, reviews, analyzer, new InsightAggregator(), silentLogger, 500);
    return {
      importReviews: new ImportReviews(access, reviews),
      requestAnalysis: new RequestAnalysis(access, reviews, analyses, analyzer, queue),
      worker: new AnalysisWorker(analyses, execute, silentLogger),
    };
  };

  beforeEach(async () => {
    businesses = new InMemoryBusinesses();
    reviews = new InMemoryReviews();
    analyses = new InMemoryAnalyses();
    queue = new ManualQueue();
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
    const { importReviews, requestAnalysis, worker } = build(new HeuristicReviewAnalyzer());
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
    await worker.drain();

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

  it('si la IA falla sin remedio, el análisis queda "failed" con un mensaje apto para el usuario', async () => {
    const broken: ReviewAnalyzer = {
      providerName: 'roto',
      batchSize: 10,
      discoverTopics: async () => {
        throw new AnalyzerError('La credencial del servicio de IA no es válida.');
      },
      classify: async () => [],
      recommend: async () => [],
    };
    const { importReviews, requestAnalysis, worker } = build(broken);
    await importReviews.execute(businessId, 'owner', [{ content: 'Todo bien' }], 'manual');
    const run = await requestAnalysis.execute(businessId, 'owner');
    await worker.drain();

    const stored = await analyses.findById(run.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('La credencial del servicio de IA no es válida.');
    expect(stored?.attempts).toBe(1); // un error no transitorio no se reintenta
  });

  it('el segundo análisis recibe la taxonomía anterior y el dashboard muestra la evolución', async () => {
    const received: string[][] = [];
    const heuristic = new HeuristicReviewAnalyzer();
    const spy: ReviewAnalyzer = {
      providerName: heuristic.providerName,
      batchSize: heuristic.batchSize,
      discoverTopics: async (_sample, _ctx, previous = []) => {
        received.push(previous.map((t) => t.key));
        return heuristic.discoverTopics();
      },
      classify: (batch) => heuristic.classify(batch),
      recommend: (stats, ctx) => heuristic.recommend(stats, ctx),
    };
    const { importReviews, requestAnalysis, worker } = build(spy);
    const dashboard = new GetDashboard(new BusinessAccess(businesses), reviews, analyses, new InsightComparator());

    await importReviews.execute(
      businessId,
      'owner',
      [
        { content: 'Se demoraron una hora, pésimo', rating: 1 },
        { content: 'Lento y frío', rating: 1 },
      ],
      'csv',
    );
    await requestAnalysis.execute(businessId, 'owner');
    await worker.drain();
    expect((await dashboard.execute(businessId, 'owner')).comparison).toBeNull();

    await importReviews.execute(
      businessId,
      'owner',
      [
        { content: 'Excelente y rapidísimo', rating: 5 },
        { content: 'Delicioso, atención rápida', rating: 5 },
      ],
      'csv',
    );
    await new Promise((r) => setTimeout(r, 5)); // createdAt distinto para ordenar los análisis
    await requestAnalysis.execute(businessId, 'owner');
    await worker.drain();

    expect(received[0]).toEqual([]);
    expect(received[1]).toContain('tiempo_espera');

    const d = await dashboard.execute(businessId, 'owner');
    expect(d.previousRun).not.toBeNull();
    expect(d.comparison!.negativeShareDelta).toBeLessThan(0);
    expect(d.comparison!.topics.find((t) => t.key === 'tiempo_espera')?.trend).toBe('improved');
  });

  describe('cola persistente', () => {
    afterEach(() => vi.useRealTimers());

    it('solicitar un análisis lo deja en la cola y avisa al worker, sin ejecutarlo en la petición', async () => {
      const { importReviews, requestAnalysis, worker } = build(new HeuristicReviewAnalyzer());
      await importReviews.execute(businessId, 'owner', [{ content: 'Muy rico todo' }], 'manual');
      const run = await requestAnalysis.execute(businessId, 'owner');

      expect(run.status).toBe('pending');
      expect(queue.wakes).toBe(1);
      expect(await worker.drain()).toBe(1);
      expect((await analyses.findById(run.id))?.status).toBe('completed');
      expect(await worker.drain()).toBe(0); // nunca se procesa dos veces
    });

    it('ante un error transitorio reintenta con espera creciente y falla al agotar los intentos', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      let calls = 0;
      const saturated: ReviewAnalyzer = {
        providerName: 'saturado',
        batchSize: 10,
        discoverTopics: async () => {
          calls++;
          throw new AnalyzerError('El servicio de IA está saturado.', true);
        },
        classify: async () => [],
        recommend: async () => [],
      };
      const { importReviews, requestAnalysis, worker } = build(saturated);
      await importReviews.execute(businessId, 'owner', [{ content: 'Todo bien' }], 'manual');
      const run = await requestAnalysis.execute(businessId, 'owner');

      await worker.drain();
      let stored = (await analyses.findById(run.id))!;
      expect(stored).toMatchObject({ status: 'pending', attempts: 1, error: 'El servicio de IA está saturado.' });
      expect(await worker.drain()).toBe(0); // todavía no le toca: espera RETRY_BASE_DELAY_MS

      vi.setSystemTime(Date.now() + RETRY_BASE_DELAY_MS + 1);
      await worker.drain();
      expect((await analyses.findById(run.id))!.attempts).toBe(2);

      vi.setSystemTime(Date.now() + 2 * RETRY_BASE_DELAY_MS + 1);
      await worker.drain();
      stored = (await analyses.findById(run.id))!;
      expect(stored).toMatchObject({ status: 'failed', attempts: 3 });
      expect(calls).toBe(3);
    });

    it('tras un reinicio, lo que quedó "running" vuelve a la cola y se completa', async () => {
      const { importReviews, requestAnalysis, worker } = build(new HeuristicReviewAnalyzer());
      await importReviews.execute(businessId, 'owner', [{ content: 'Excelente atención' }], 'manual');
      const run = await requestAnalysis.execute(businessId, 'owner');
      (await analyses.claimNext())!; // el proceso "muere" justo después de tomar el trabajo

      expect(await analyses.recoverInterrupted('Reinicio')).toEqual({ requeued: 1, failed: 0 });
      expect(await worker.drain()).toBe(1);
      expect((await analyses.findById(run.id))!).toMatchObject({ status: 'completed', attempts: 2, error: null });
    });
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
    const { importReviews, requestAnalysis, worker } = build(hallucinating);
    await importReviews.execute(businessId, 'owner', [{ content: 'Demasiada espera' }], 'manual');
    const run = await requestAnalysis.execute(businessId, 'owner');
    await worker.drain();

    const results = analyses.results.get(run.id)!;
    expect(results.classifications).toHaveLength(1);
    expect(results.classifications[0]!.topicKeys).toEqual(['tiempo_de_espera']);
  });
});
