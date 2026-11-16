import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../../src/app.js';
import { JwtTokenService } from '../../src/infrastructure/security/JwtTokenService.js';
import { RealtimeTicketService } from '../../src/infrastructure/security/RealtimeTicketService.js';
import { buildTestApp, FRONTEND_ORIGIN, type TestApp } from '../support/testApp.js';

/**
 * Pruebas de integración del canal en tiempo real: servidor HTTP real con el gateway enganchado y
 * clientes `ws` reales, como un navegador. Cubren autenticación por ticket y por cookie, Origin,
 * aislamiento entre usuarios (IDOR), el fan-out a varias pestañas y la secuencia de estados.
 */
const CSRF = { 'X-Requested-With': 'PulsoLocal' };

interface Message {
  type: string;
  businessId?: string;
  code?: string;
  run?: { id: string; status: string };
}

/** Cliente de prueba que guarda todo lo recibido y permite esperar un mensaje concreto. */
class TestClient {
  readonly received: Message[] = [];
  private waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Message;
      this.received.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
  }

  static open(url: string, headers: Record<string, string> = { Origin: FRONTEND_ORIGIN }): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  next(match: (m: Message) => boolean, timeoutMs = 3000): Promise<Message> {
    const already = this.received.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No llegó el mensaje esperado')), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}

describe('Tiempo real (WebSocket)', () => {
  let testApp: TestApp;
  let server: Server;
  let wsBase: string;
  let owner: string[];
  let intruder: string[];
  let businessId: string;

  const ticketFor = async (cookie: string[]) => {
    const res = await request(server).post('/api/realtime/ticket').set(CSRF).set('Cookie', cookie);
    expect(res.status).toBe(201);
    return res.body.ticket as string;
  };
  const connect = async (cookie: string[]) => {
    const client = await TestClient.open(`${wsBase}?ticket=${encodeURIComponent(await ticketFor(cookie))}`);
    await client.next((m) => m.type === 'ready');
    return client;
  };
  const register = async (email: string) => {
    const res = await request(server).post('/api/auth/register').set(CSRF).send({ name: 'Persona', email, password: 'Galeras2026x' });
    return res.get('Set-Cookie')!;
  };

  beforeAll(async () => {
    testApp = buildTestApp();
    server = createServer(createApp(testApp.deps));
    testApp.realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;

    owner = await register('dueno@tiempo-real.co');
    intruder = await register('otro@tiempo-real.co');
    const created = await request(server)
      .post('/api/businesses')
      .set(CSRF)
      .set('Cookie', owner)
      .send({ name: 'Café Galeras', category: 'cafeteria' });
    businessId = created.body.id;
    await request(server)
      .post(`/api/businesses/${businessId}/reviews/text`)
      .set(CSRF)
      .set('Cookie', owner)
      .send({ text: 'Excelente café\nMe demoraron una hora, pésimo\nBuen precio' });
  });

  afterAll(async () => {
    testApp.realtime.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('entrega a todas las pestañas suscritas cada cambio de estado del análisis (fan-out)', async () => {
    const tab1 = await connect(owner);
    const tab2 = await connect(owner);
    for (const tab of [tab1, tab2]) {
      tab.send({ type: 'subscribe', businessId });
      await tab.next((m) => m.type === 'subscribed' && m.businessId === businessId);
    }

    const start = await request(server).post(`/api/businesses/${businessId}/analyses`).set(CSRF).set('Cookie', owner);
    expect(start.status).toBe(202);

    for (const tab of [tab1, tab2]) {
      const done = await tab.next((m) => m.type === 'analysis' && m.run?.status === 'completed');
      expect(done.run?.id).toBe(start.body.id);
      // Llegó la secuencia completa, en orden: en cola → en curso → completado.
      const statuses = tab.received.filter((m) => m.type === 'analysis').map((m) => m.run?.status);
      expect(statuses).toEqual(['pending', 'running', 'completed']);
    }
    expect(testApp.realtime.stats()).toMatchObject({ connections: 2, rooms: 1 });

    tab1.close();
    tab2.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Al cerrar, el estado por conexión se libera: sin conexiones ni salas en memoria.
    expect(testApp.realtime.stats()).toEqual({ connections: 0, rooms: 0 });
  });

  it('otro usuario no puede suscribirse a un negocio ajeno ni recibir sus eventos (IDOR)', async () => {
    const spy = await connect(intruder);
    spy.send({ type: 'subscribe', businessId });
    const error = await spy.next((m) => m.type === 'error');
    expect(error.code).toBe('NOT_FOUND');

    testApp.bus.publish({ businessId, run: { id: 'x', status: 'running' } as never });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spy.received.some((m) => m.type === 'analysis')).toBe(false);
    spy.close();
  });

  it('rechaza mensajes mal formados sin cerrar la conexión', async () => {
    const client = await connect(owner);
    client.send({ type: 'subscribe', businessId: "' OR 1=1--" });
    expect((await client.next((m) => m.type === 'error')).code).toBe('BAD_MESSAGE');
    client.ws.send('esto no es JSON');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.received.filter((m) => m.code === 'BAD_MESSAGE')).toHaveLength(2);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('el ticket es de un solo uso y no sirve como cookie de sesión', async () => {
    const ticket = await ticketFor(owner);
    const first = await TestClient.open(`${wsBase}?ticket=${encodeURIComponent(ticket)}`);
    await expect(TestClient.open(`${wsBase}?ticket=${encodeURIComponent(ticket)}`)).rejects.toThrow('HTTP 401');
    first.close();

    const tokens = new JwtTokenService('clave-de-prueba-con-mas-de-32-caracteres', 1);
    expect(tokens.verify(ticket)).toBeNull(); // otra audiencia: no abre la API
    expect(new RealtimeTicketService('otra-clave-de-mas-de-32-caracteres-xx').redeem(ticket)).toBeNull();
  });

  it('exige sesión y un Origin de la lista blanca (evita el secuestro del socket entre sitios)', async () => {
    await expect(TestClient.open(wsBase)).rejects.toThrow('HTTP 401');
    const ticket = await ticketFor(owner);
    await expect(TestClient.open(`${wsBase}?ticket=${ticket}`, { Origin: 'https://sitio-malicioso.example' })).rejects.toThrow('HTTP 403');
    // En el mismo origen (proxy de Vite o nginx) basta con la cookie de sesión.
    const sameOrigin = await TestClient.open(wsBase, { Origin: FRONTEND_ORIGIN, Cookie: owner.map((c) => c.split(';')[0]).join('; ') });
    await sameOrigin.next((m) => m.type === 'ready');
    sameOrigin.close();
  });

  it('el ticket solo se entrega con sesión y con el header anti-CSRF', async () => {
    expect((await request(server).post('/api/realtime/ticket').set(CSRF)).status).toBe(401);
    expect((await request(server).post('/api/realtime/ticket').set('Cookie', owner)).status).toBe(403);
  });
});
