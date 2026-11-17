import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AnalysisRun } from '../../src/domain/entities/AnalysisRun.js';
import { Email } from '../../src/domain/value-objects/Email.js';
import { buildTestApp, type TestApp } from '../support/testApp.js';

/**
 * Control de acceso por roles (RBAC): un usuario normal no puede usar el panel de administración,
 * el administrador ve solo cifras agregadas (nunca reseñas ajenas) y el rol se revisa en cada
 * petición, así que quitarlo surte efecto de inmediato.
 */
const CSRF = { 'X-Requested-With': 'PulsoLocal' };
const PASSWORD = 'Galeras2026x';

describe('Panel de administración', () => {
  let testApp: TestApp;
  let app: ReturnType<typeof createApp>;
  let owner: string[];
  let admin: string[];
  let ownerId: string;
  let businessId: string;

  const register = async (email: string) => {
    const res = await request(app).post('/api/auth/register').set(CSRF).send({ name: 'Persona', email, password: PASSWORD });
    return { cookie: res.get('Set-Cookie')!, id: res.body.user.id as string };
  };
  const setRole = async (email: string, role: 'admin' | 'user') => {
    const user = (await testApp.users.findByEmail(Email.create(email)))!;
    if (role === 'admin') user.promoteToAdmin();
    else user.revokeAdmin();
    await testApp.users.save(user);
  };

  beforeAll(async () => {
    testApp = buildTestApp();
    app = createApp(testApp.deps);
    const o = await register('dueno@admin-test.co');
    owner = o.cookie;
    ownerId = o.id;
    admin = (await register('admin@admin-test.co')).cookie;
    await setRole('admin@admin-test.co', 'admin'); // como lo haría npm run make-admin

    businessId = (
      await request(app).post('/api/businesses').set(CSRF).set('Cookie', owner).send({ name: 'Café Galeras', category: 'cafeteria' })
    ).body.id;
    await request(app)
      .post(`/api/businesses/${businessId}/reviews/text`)
      .set(CSRF)
      .set('Cookie', owner)
      .send({ text: 'Excelente café secreto\nMe demoraron una hora' });
  });

  it('un usuario normal recibe 403 en todas las rutas de administración, y sin sesión 401', async () => {
    const someId = '00000000-0000-4000-8000-000000000000';
    const routes = [
      request(app).get('/api/admin/dashboard'),
      request(app).get('/api/admin/users'),
      request(app).post(`/api/admin/users/${someId}/unlock`).set(CSRF),
      request(app).post(`/api/admin/analyses/${someId}/retry`).set(CSRF),
    ];
    for (const req of routes) {
      const res = await req.set('Cookie', owner);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect((await request(app).get('/api/admin/dashboard')).status).toBe(401);
  });

  it('/auth/me informa el rol, para que el frontend muestre u oculte el panel', async () => {
    expect((await request(app).get('/api/auth/me').set('Cookie', owner)).body.user.role).toBe('user');
    expect((await request(app).get('/api/auth/me').set('Cookie', admin)).body.user.role).toBe('admin');
  });

  it('el administrador ve cifras de la plataforma y usuarios, pero nunca el texto de las reseñas', async () => {
    const dashboard = await request(app).get('/api/admin/dashboard').set('Cookie', admin);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.overview).toMatchObject({ users: 2, admins: 1, businesses: 1, reviews: 2 });
    expect(dashboard.body.usage).toHaveLength(14);

    const users = await request(app).get('/api/admin/users').set('Cookie', admin);
    const row = users.body.items.find((u: { email: string }) => u.email === 'dueno@admin-test.co');
    expect(row).toMatchObject({ role: 'user', businesses: 1, reviews: 2, lockedUntil: null });
    expect(JSON.stringify([dashboard.body, users.body])).not.toContain('secreto');
  });

  it('desbloquea una cuenta bloqueada por intentos fallidos', async () => {
    const login = (password: string) => request(app).post('/api/auth/login').set(CSRF).send({ email: 'dueno@admin-test.co', password });
    for (let i = 0; i < 5; i++) await login('errada-123x');
    expect((await login(PASSWORD)).status).toBe(423);

    const listed = await request(app).get('/api/admin/users').set('Cookie', admin);
    expect(listed.body.items.find((u: { id: string }) => u.id === ownerId).lockedUntil).not.toBeNull();

    expect((await request(app).post(`/api/admin/users/${ownerId}/unlock`).set(CSRF).set('Cookie', admin)).status).toBe(200);
    expect((await login(PASSWORD)).status).toBe(200);
  });

  it('reintenta un análisis fallido y rechaza reintentar lo que no falló', async () => {
    const failed = AnalysisRun.request({ businessId, provider: 'gemini:prueba', reviewCount: 2 });
    failed.start();
    failed.fail('La IA está saturada');
    await testApp.analyses.save(failed);

    const dashboard = await request(app).get('/api/admin/dashboard').set('Cookie', admin);
    expect(dashboard.body.failed[0]).toMatchObject({ runId: failed.id, businessName: 'Café Galeras', ownerEmail: 'dueno@admin-test.co' });

    const retry = await request(app).post(`/api/admin/analyses/${failed.id}/retry`).set(CSRF).set('Cookie', admin);
    expect(retry.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    // El dueño ve el análisis nuevo completado en su dashboard.
    const owned = await request(app).get(`/api/businesses/${businessId}/dashboard`).set('Cookie', owner);
    expect(owned.body.reportRun.id).toBe(retry.body.id);

    expect((await request(app).post(`/api/admin/analyses/${retry.body.id}/retry`).set(CSRF).set('Cookie', admin)).status).toBe(409);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await request(app).post(`/api/admin/analyses/${missing}/retry`).set(CSRF).set('Cookie', admin)).status).toBe(404);
  });

  it('al quitarle el rol pierde el acceso en la siguiente petición (no queda guardado en el token)', async () => {
    await setRole('admin@admin-test.co', 'user');
    expect((await request(app).get('/api/admin/dashboard').set('Cookie', admin)).status).toBe(403);
    await setRole('admin@admin-test.co', 'admin');
    expect((await request(app).get('/api/admin/dashboard').set('Cookie', admin)).status).toBe(200);
  });
});
