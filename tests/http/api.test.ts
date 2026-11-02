import { pino } from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AppDependencies, createApp } from '../../src/app.js';
import { GetAnalysis, GetDashboard, GetSentimentTrend } from '../../src/application/use-cases/analysis/AnalysisQueries.js';
import { AnalysisWorker } from '../../src/application/use-cases/analysis/AnalysisWorker.js';
import { ExecuteAnalysis } from '../../src/application/use-cases/analysis/ExecuteAnalysis.js';
import { RequestAnalysis } from '../../src/application/use-cases/analysis/RequestAnalysis.js';
import { AuthenticateUser } from '../../src/application/use-cases/auth/AuthenticateUser.js';
import { GetCurrentUser } from '../../src/application/use-cases/auth/GetCurrentUser.js';
import { RegisterUser } from '../../src/application/use-cases/auth/RegisterUser.js';
import { ChangePassword, ValidateSession } from '../../src/application/use-cases/auth/SessionUseCases.js';
import { BusinessAccess } from '../../src/application/use-cases/businesses/BusinessAccess.js';
import {
  CreateBusiness,
  DeleteBusiness,
  GetBusiness,
  ListBusinesses,
  UpdateBusiness,
} from '../../src/application/use-cases/businesses/BusinessUseCases.js';
import {
  ClearReviews,
  DeleteReview,
  ExportReviews,
  ImportReviews,
  ListReviews,
} from '../../src/application/use-cases/reviews/ReviewUseCases.js';
import { InsightAggregator } from '../../src/domain/services/InsightAggregator.js';
import { InsightComparator } from '../../src/domain/services/InsightComparator.js';
import { SentimentTrend } from '../../src/domain/services/SentimentTrend.js';
import { HeuristicReviewAnalyzer } from '../../src/infrastructure/ai/HeuristicReviewAnalyzer.js';
import { CsvReviewExporter } from '../../src/infrastructure/csv/CsvReviewExporter.js';
import { CsvReviewParser, PastedTextParser } from '../../src/infrastructure/csv/ReviewTextParsers.js';
import { JwtTokenService } from '../../src/infrastructure/security/JwtTokenService.js';
import { AnalysisController } from '../../src/interfaces/http/controllers/AnalysisController.js';
import { AuthController } from '../../src/interfaces/http/controllers/AuthController.js';
import { BusinessController } from '../../src/interfaces/http/controllers/BusinessController.js';
import { ReviewController } from '../../src/interfaces/http/controllers/ReviewController.js';
import { FakeHasher, InMemoryAnalyses, InMemoryBusinesses, InMemoryReviews, InMemoryUsers, silentLogger } from '../fakes.js';

/**
 * Pruebas de integración de la capa HTTP: la app Express real (middlewares de seguridad,
 * validación, controladores, casos de uso) sobre repositorios en memoria. Atacan la API
 * igual que lo haría un cliente o un atacante, sin necesitar PostgreSQL.
 */
function buildApp() {
  const users = new InMemoryUsers();
  const businesses = new InMemoryBusinesses();
  const reviews = new InMemoryReviews();
  const analyses = new InMemoryAnalyses(reviews);
  const hasher = new FakeHasher();
  const tokens = new JwtTokenService('clave-de-prueba-con-mas-de-32-caracteres', 1);
  const analyzer = new HeuristicReviewAnalyzer();
  const access = new BusinessAccess(businesses);
  const execute = new ExecuteAnalysis(analyses, businesses, reviews, analyzer, new InsightAggregator(), silentLogger, 500);
  const worker = new AnalysisWorker(analyses, execute, silentLogger);
  // Cola de prueba: al recibir el aviso vacía la cola en el acto (como haría PollingJobRunner).
  const jobs = { wake: () => void worker.drain() };

  const deps: AppDependencies = {
    config: { FRONTEND_ORIGIN: 'http://localhost:5180', TRUST_PROXY: false },
    logger: pino({ level: 'silent' }),
    db: { ping: async () => true },
    tokens,
    sessions: new ValidateSession(users),
    analyzer,
    authController: new AuthController(
      new RegisterUser(users, hasher),
      new AuthenticateUser(users, hasher, tokens),
      new GetCurrentUser(users),
      new ChangePassword(users, hasher, tokens),
      { secure: false, maxAgeMs: tokens.maxAgeMs },
    ),
    businessController: new BusinessController(
      new CreateBusiness(businesses),
      new ListBusinesses(businesses),
      new GetBusiness(access),
      new DeleteBusiness(access, businesses),
      new UpdateBusiness(access, businesses),
    ),
    reviewController: new ReviewController(
      new ImportReviews(access, reviews),
      new ListReviews(access, reviews),
      new ClearReviews(access, reviews),
      new ExportReviews(access, reviews),
      new CsvReviewParser(),
      new PastedTextParser(),
      new CsvReviewExporter(),
      new DeleteReview(access, reviews),
    ),
    analysisController: new AnalysisController(
      new RequestAnalysis(access, reviews, analyses, analyzer, jobs),
      new GetAnalysis(access, analyses),
      new GetDashboard(access, reviews, analyses, new InsightComparator()),
      new GetSentimentTrend(access, analyses, new SentimentTrend()),
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
    const res = await request(app)
      .post('/api/businesses')
      .set(CSRF)
      .set('Cookie', owner)
      .send({ name: 'Café Galeras', category: 'cafeteria' });
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

    it('tras 5 contraseñas erradas responde 423 y no deja entrar ni con la correcta', async () => {
      await register('victima@cafe.co', 'Galeras2026x');
      const attempt = (password: string) => request(app).post('/api/auth/login').set(CSRF).send({ email: 'victima@cafe.co', password });
      for (let i = 0; i < 4; i++) expect((await attempt('errada-123x')).status).toBe(401);
      const locked = await attempt('errada-123x');
      expect(locked.status).toBe(423);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      expect((await attempt('Galeras2026x')).status).toBe(423);
    });

    it('el límite de intentos es por cuenta: los fallos con un correo no bloquean otro correo de la misma IP', async () => {
      const attempt = (email: string) => request(app).post('/api/auth/login').set(CSRF).send({ email, password: 'cualquiera-123' });
      for (let i = 0; i < 10; i++) await attempt('atacada@cafe.co');
      const limited = await attempt('atacada@cafe.co');
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect((await attempt('otra.persona@cafe.co')).status).toBe(401); // misma IP, otra cuenta
    });

    it('cambiar la contraseña cierra las demás sesiones y mantiene la actual', async () => {
      const email = 'cambio@cafe.co';
      const sessionA = await register(email, 'Galeras2026x');
      const login = (password: string) => request(app).post('/api/auth/login').set(CSRF).send({ email, password });
      const sessionB = (await login('Galeras2026x')).get('Set-Cookie')!; // otro dispositivo
      const change = (cookie: string[], body: object) => request(app).post('/api/auth/password').set(CSRF).set('Cookie', cookie).send(body);

      expect((await change(sessionA, { currentPassword: 'errada-999x', newPassword: 'NuevaClave2027' })).status).toBe(401);
      expect((await change(sessionA, { currentPassword: 'Galeras2026x', newPassword: 'corta1' })).status).toBe(400);
      expect((await change(sessionA, { currentPassword: 'Galeras2026x', newPassword: 'Galeras2026x' })).status).toBe(400);

      const ok = await change(sessionA, { currentPassword: 'Galeras2026x', newPassword: 'NuevaClave2027' });
      expect(ok.status).toBe(204);
      const renewedA = ok.get('Set-Cookie')!;

      expect((await request(app).get('/api/auth/me').set('Cookie', renewedA)).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Cookie', sessionA)).status).toBe(401); // token anterior
      expect((await request(app).get('/api/auth/me').set('Cookie', sessionB)).status).toBe(401); // el otro dispositivo
      expect((await login('Galeras2026x')).status).toBe(401);
      expect((await login('NuevaClave2027')).status).toBe(200);
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

    it('el dueño edita su negocio; un intruso no puede, ni se puede cambiar el dueño', async () => {
      const url = `/api/businesses/${businessId}`;
      const ok = await request(app).patch(url).set(CSRF).set('Cookie', owner).send({ city: 'Pasto', name: 'Café Galeras Centro' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: 'Café Galeras Centro', city: 'Pasto', category: 'cafeteria' });

      expect((await request(app).patch(url).set(CSRF).set('Cookie', intruder).send({ name: 'Hackeado' })).status).toBe(404);
      expect((await request(app).patch(url).set(CSRF).set('Cookie', owner).send({ ownerId: 'otro' })).status).toBe(400);
      expect((await request(app).patch(url).set(CSRF).set('Cookie', owner).send({})).status).toBe(400);
      expect((await request(app).patch(url).set('Cookie', owner).send({ name: 'Sin CSRF' })).status).toBe(403);
    });

    it('rechaza campos no declarados (mass assignment) e IDs inválidos', async () => {
      const res = await request(app)
        .post('/api/businesses')
        .set(CSRF)
        .set('Cookie', owner)
        .send({ name: 'Tienda', category: 'tienda', ownerId: 'hack' });
      expect(res.status).toBe(400);
      expect((await request(app).get("/api/businesses/1' OR 1=1--").set('Cookie', owner)).status).toBe(400);
    });
  });

  describe('listado de reseñas', () => {
    it('filtra por calificación, ordena y rechaza órdenes fuera de la lista blanca', async () => {
      const biz = await request(app).post('/api/businesses').set(CSRF).set('Cookie', owner).send({ name: 'Panadería', category: 'tienda' });
      const csv = ['comentario;calificacion', 'Pan duro;1', 'Pan delicioso;5', 'Pan normal;3', 'Pan frío;1'].join('\n');
      await request(app)
        .post(`/api/businesses/${biz.body.id}/reviews/csv`)
        .set(CSRF)
        .set('Cookie', owner)
        .attach('file', Buffer.from(csv), { filename: 'r.csv', contentType: 'text/csv' });
      const url = `/api/businesses/${biz.body.id}/reviews`;

      const ones = await request(app).get(url).query({ rating: 1 }).set('Cookie', owner);
      expect(ones.body.total).toBe(2);
      expect(ones.body.items.every((r: { rating: number }) => r.rating === 1)).toBe(true);

      const asc = await request(app).get(url).query({ sort: 'rating_asc' }).set('Cookie', owner);
      expect(asc.body.items.map((r: { rating: number }) => r.rating)).toEqual([1, 1, 3, 5]);

      expect((await request(app).get(url).query({ sort: 'r.rating; DROP TABLE reviews' }).set('Cookie', owner)).status).toBe(400);
      expect((await request(app).get(url).query({ rating: 9 }).set('Cookie', owner)).status).toBe(400);
    });
  });

  describe('reseñas individuales', () => {
    it('el dueño elimina una reseña suya; el intruso y los IDs ajenos reciben 404', async () => {
      const otherBiz = await request(app)
        .post('/api/businesses')
        .set(CSRF)
        .set('Cookie', owner)
        .send({ name: 'Tienda Dos', category: 'tienda' });
      await request(app)
        .post(`/api/businesses/${otherBiz.body.id}/reviews/text`)
        .set(CSRF)
        .set('Cookie', owner)
        .send({ text: 'Reseña de spam para borrar' });
      const list = await request(app).get(`/api/businesses/${otherBiz.body.id}/reviews`).set('Cookie', owner);
      const reviewId: string = list.body.items[0].id;
      const url = `/api/businesses/${otherBiz.body.id}/reviews/${reviewId}`;

      expect((await request(app).delete(url).set(CSRF).set('Cookie', intruder)).status).toBe(404);
      // La reseña existe pero pertenece a otro negocio: tampoco se puede borrar por esa vía.
      expect((await request(app).delete(`/api/businesses/${businessId}/reviews/${reviewId}`).set(CSRF).set('Cookie', owner)).status).toBe(
        404,
      );
      expect((await request(app).delete(url).set(CSRF).set('Cookie', owner)).status).toBe(204);
      expect((await request(app).delete(url).set(CSRF).set('Cookie', owner)).status).toBe(404);
      expect((await request(app).get(`/api/businesses/${otherBiz.body.id}/reviews`).set('Cookie', owner)).body.total).toBe(0);
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

      const trend = await request(app).get(`/api/businesses/${businessId}/trend`).set('Cookie', owner);
      expect(trend.status).toBe(200);
      expect(trend.body.points.reduce((n: number, p: { total: number }) => n + p.total, 0)).toBe(3);
      expect((await request(app).get(`/api/businesses/${businessId}/trend`).query({ months: 99 }).set('Cookie', owner)).status).toBe(400);
      expect((await request(app).get(`/api/businesses/${businessId}/trend`).set('Cookie', intruder)).status).toBe(404);

      const exported = await request(app).get(`/api/businesses/${businessId}/reviews/export`).set('Cookie', owner);
      expect(exported.headers['content-type']).toMatch(/text\/csv/);
      expect(exported.headers['content-disposition']).toMatch(/attachment; filename="resenas-cafe-galeras-/);
      expect(exported.text).toContain(`"'=HYPERLINK(""http://evil.co"")"`);
    });
  });
});
