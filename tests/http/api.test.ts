import { pino } from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from '../../src/app.js';
import { GetAnalysis, GetDashboard } from '../../src/application/use-cases/analysis/AnalysisQueries.js';
import { ExecuteAnalysis } from '../../src/application/use-cases/analysis/ExecuteAnalysis.js';
import { RequestAnalysis } from '../../src/application/use-cases/analysis/RequestAnalysis.js';
import { AuthenticateUser } from '../../src/application/use-cases/auth/AuthenticateUser.js';
import { GetCurrentUser } from '../../src/application/use-cases/auth/GetCurrentUser.js';
import { RegisterUser } from '../../src/application/use-cases/auth/RegisterUser.js';
import { BusinessAccess } from '../../src/application/use-cases/businesses/BusinessAccess.js';
import { CreateBusiness, DeleteBusiness, GetBusiness, ListBusinesses } from '../../src/application/use-cases/businesses/BusinessUseCases.js';
import { ClearReviews, ExportReviews, ImportReviews, ListReviews } from '../../src/application/use-cases/reviews/ReviewUseCases.js';
import { InsightAggregator } from '../../src/domain/services/InsightAggregator.js';
import { InsightComparator } from '../../src/domain/services/InsightComparator.js';
import { HeuristicReviewAnalyzer } from '../../src/infrastructure/ai/HeuristicReviewAnalyzer.js';
import { CsvReviewExporter } from '../../src/infrastructure/csv/CsvReviewExporter.js';
import { CsvReviewParser, PastedTextParser } from '../../src/infrastructure/csv/ReviewTextParsers.js';
import { JwtTokenService } from '../../src/infrastructure/security/JwtTokenService.js';
import { AnalysisController } from '../../src/interfaces/http/controllers/AnalysisController.js';
import { AuthController } from '../../src/interfaces/http/controllers/AuthController.js';
import { BusinessController } from '../../src/interfaces/http/controllers/BusinessController.js';
import { ReviewController } from '../../src/interfaces/http/controllers/ReviewController.js';
import { FakeHasher, ImmediateScheduler, InMemoryAnalyses, InMemoryBusinesses, InMemoryReviews, InMemoryUsers, silentLogger } from '../fakes.js';

/**
 * Pruebas de integración de la capa HTTP: la app Express real (middlewares de seguridad,
 * validación, controladores, casos de uso) sobre repositorios en memoria. Atacan la API
 * igual que lo haría un cliente o un atacante, sin necesitar PostgreSQL.
 */
function buildApp() {
  const users = new InMemoryUsers();
  const businesses = new InMemoryBusinesses();
  const reviews = new InMemoryReviews();
  const analyses = new InMemoryAnalyses();
  const hasher = new FakeHasher();
  const tokens = new JwtTokenService('clave-de-prueba-con-mas-de-32-caracteres', 1);
  const analyzer = new HeuristicReviewAnalyzer();
  const access = new BusinessAccess(businesses);
  const execute = new ExecuteAnalysis(analyses, businesses, reviews, analyzer, new InsightAggregator(), silentLogger, 500);

  const deps: AppDependencies = {
    config: { FRONTEND_ORIGIN: 'http://localhost:5180', TRUST_PROXY: false },
    logger: pino({ level: 'silent' }),
    db: { ping: async () => true },
    tokens,
    analyzer,
    authController: new AuthController(
      new RegisterUser(users, hasher),
      new AuthenticateUser(users, hasher, tokens),
      new GetCurrentUser(users),
      { secure: false, maxAgeMs: tokens.maxAgeMs },
    ),
    businessController: new BusinessController(
      new CreateBusiness(businesses),
      new ListBusinesses(businesses),
      new GetBusiness(access),
      new DeleteBusiness(access, businesses),
    ),
    reviewController: new ReviewController(
      new ImportReviews(access, reviews),
      new ListReviews(access, reviews),
      new ClearReviews(access, reviews),
      new ExportReviews(access, reviews),
      new CsvReviewParser(),
      new PastedTextParser(),
      new CsvReviewExporter(),
    ),
    analysisController: new AnalysisController(
      new RequestAnalysis(access, reviews, analyses, analyzer, new ImmediateScheduler(), execute),
      new GetAnalysis(access, analyses),
      new GetDashboard(access, reviews, analyses, new InsightComparator()),
    ),
  };
  return createApp(deps);
}

const CSRF = { 'X-Requested-With': 'PulsoLocal' };

describe('API HTTP', () => {
  const app = buildApp();
  let owner: string[]; // cookie de sesión del dueño
  let intruder: string[];
  let businessId: string;

  const register = async (email: string, password: string) => {
    const res = await request(app).post('/api/auth/register').set(CSRF).send({ name: 'Persona', email, password });
    expect(res.status).toBe(201);
    return res.get('Set-Cookie')!;
  };

  beforeAll(async () => {
    owner = await register('dueno@cafe.co', 'Galeras2026x');
    intruder = await register('otro@mail.co', 'Montana98765z');
    const res = await request(app).post('/api/businesses').set(CSRF).set('Cookie', owner).send({ name: 'Café Galeras', category: 'cafeteria' });
    businessId = res.body.id;
  });

  describe('cabeceras y errores', () => {
    it('envía cabeceras de seguridad y oculta la tecnología', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('responde JSON uniforme ante rutas inexistentes y JSON mal formado', async () => {
      expect((await request(app).get('/api/no-existe')).body.error.code).toBe('ROUTE_NOT_FOUND');
      const bad = await request(app).post('/api/auth/login').set(CSRF).set('Content-Type', 'application/json').send('{"email":');
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('BAD_JSON');
    });
  });

  describe('autenticación y sesión', () => {
    it('la cookie de sesión es httpOnly y SameSite=Strict', async () => {
      const res = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'dueno@cafe.co', password: 'Galeras2026x' });
      const cookie = res.get('Set-Cookie')![0]!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    it('rechaza peticiones que modifican estado sin el header anti-CSRF', async () => {
      const res = await request(app).post('/api/businesses').set('Cookie', owner).send({ name: 'X', category: 'otro' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    });

    it('rechaza peticiones sin sesión o con un token manipulado', async () => {
      expect((await request(app).get('/api/businesses')).status).toBe(401);
      const tampered = owner[0]!.replace(/pulso_session=([^;]+)/, (_m, t: string) => `pulso_session=${t.slice(0, -3)}abc`);
      expect((await request(app).get('/api/businesses').set('Cookie', tampered)).status).toBe(401);
    });
  });

  describe('autorización y validación', () => {
    it('otro usuario no puede leer, exportar ni borrar el negocio (IDOR → 404)', async () => {
      expect((await request(app).get(`/api/businesses/${businessId}/dashboard`).set('Cookie', intruder)).status).toBe(404);
      expect((await request(app).get(`/api/businesses/${businessId}/reviews/export`).set('Cookie', intruder)).status).toBe(404);
      expect((await request(app).delete(`/api/businesses/${businessId}`).set(CSRF).set('Cookie', intruder)).status).toBe(404);
      expect((await request(app).get(`/api/businesses/${businessId}`).set('Cookie', owner)).status).toBe(200);
    });

    it('rechaza campos no declarados (mass assignment) e IDs inválidos', async () => {
      const res = await request(app).post('/api/businesses').set(CSRF).set('Cookie', owner).send({ name: 'Tienda', category: 'tienda', ownerId: 'hack' });
      expect(res.status).toBe(400);
      expect((await request(app).get("/api/businesses/1' OR 1=1--").set('Cookie', owner)).status).toBe(400);
    });
  });

  describe('flujo completo', () => {
    it('rechaza archivos que no son CSV', async () => {
      const res = await request(app)
        .post(`/api/businesses/${businessId}/reviews/csv`)
        .set(CSRF)
        .set('Cookie', owner)
        .attach('file', Buffer.from([0x4d, 0x5a, 0x00, 0x01]), { filename: 'virus.exe', contentType: 'application/octet-stream' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
    });

    it('importa un CSV, analiza y exporta con las fórmulas neutralizadas', async () => {
      const csv = 'comentario;calificacion\nSe demoraron una hora, pésimo;1\nEl café delicioso;5\n=HYPERLINK("http://evil.co");3\n';
      const up = await request(app)
        .post(`/api/businesses/${businessId}/reviews/csv`)
        .set(CSRF)
        .set('Cookie', owner)
        .attach('file', Buffer.from(csv), { filename: 'resenas.csv', contentType: 'text/csv' });
      expect(up.status).toBe(201);
      expect(up.body.imported).toBe(3);

      const start = await request(app).post(`/api/businesses/${businessId}/analyses`).set(CSRF).set('Cookie', owner);
      expect(start.status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));

      const dashboard = await request(app).get(`/api/businesses/${businessId}/dashboard`).set('Cookie', owner);
      expect(dashboard.body.reportRun.status).toBe('completed');
      expect(dashboard.body.report.stats.totalReviews).toBe(3);

      const exported = await request(app).get(`/api/businesses/${businessId}/reviews/export`).set('Cookie', owner);
      expect(exported.headers['content-type']).toMatch(/text\/csv/);
      expect(exported.headers['content-disposition']).toMatch(/attachment; filename="resenas-cafe-galeras-/);
      expect(exported.text).toContain(`"'=HYPERLINK(""http://evil.co"")"`);
    });
  });
});
