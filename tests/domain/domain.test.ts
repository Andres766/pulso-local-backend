import { describe, expect, it } from 'vitest';
import { AnalysisRun } from '../../src/domain/entities/AnalysisRun.js';
import { Business } from '../../src/domain/entities/Business.js';
import { Review } from '../../src/domain/entities/Review.js';
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS, User } from '../../src/domain/entities/User.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors/DomainError.js';
import { InsightAggregator } from '../../src/domain/services/InsightAggregator.js';
import { Email } from '../../src/domain/value-objects/Email.js';
import { Rating } from '../../src/domain/value-objects/Rating.js';
import { Sentiment } from '../../src/domain/value-objects/Sentiment.js';

describe('Value objects', () => {
  it('Email normaliza y valida', () => {
    expect(Email.create('  Dueno@Cafe.CO ').value).toBe('dueno@cafe.co');
    expect(() => Email.create('no-es-correo')).toThrow(ValidationError);
  });

  it('Sentiment corrige puntajes incoherentes con la etiqueta', () => {
    expect(Sentiment.of('positive', -0.8).score).toBe(0.8);
    expect(Sentiment.of('negative', 0.5).score).toBe(-0.5);
    expect(Sentiment.of('neutral', 5).score).toBe(1);
    expect(Sentiment.fromScore(-0.6).label).toBe('negative');
    expect(Sentiment.fromScore(0.1).label).toBe('neutral');
  });

  it('Rating acepta 1..5 y descarta basura', () => {
    expect(Rating.tryParse('4,6')?.value).toBe(5);
    expect(Rating.tryParse('abc')).toBeNull();
    expect(Rating.tryParse(9)).toBeNull();
    expect(() => Rating.create(0)).toThrow(ValidationError);
  });
});

describe('Review', () => {
  it('limpia caracteres de control y espacios', () => {
    const r = Review.create({ businessId: 'b', content: '  Muy\u0007  buen\n\ncafé  ', source: 'manual' });
    expect(r.content).toBe('Muy buen café');
  });

  it('dos textos iguales con distinto formato tienen la misma huella', () => {
    const a = Review.create({ businessId: 'b', content: 'Excelente servicio', source: 'manual' });
    const b = Review.create({ businessId: 'b', content: '  EXCELENTE   servicio ', source: 'csv' });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('rechaza reseñas vacías o demasiado largas', () => {
    expect(() => Review.create({ businessId: 'b', content: ' ', source: 'manual' })).toThrow(ValidationError);
    expect(() => Review.create({ businessId: 'b', content: 'x'.repeat(2001), source: 'manual' })).toThrow(ValidationError);
  });
});

describe('User (bloqueo por intentos fallidos)', () => {
  const user = () => User.register({ email: Email.create('ana@cafe.co'), name: 'Ana', passwordHash: 'h' });

  it('se bloquea al quinto fallo seguido y se desbloquea sola al pasar el tiempo', () => {
    const u = user();
    const t0 = new Date('2026-11-02T10:00:00Z');
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) u.registerFailedLogin(t0);
    expect(u.isLocked(t0)).toBe(false);
    u.registerFailedLogin(t0);
    expect(u.isLocked(t0)).toBe(true);
    expect(u.minutesUntilUnlock(t0)).toBe(LOCKOUT_MINUTES);
    expect(u.isLocked(new Date(t0.getTime() + LOCKOUT_MINUTES * 60_000 + 1))).toBe(false);
  });

  it('cambiar la contraseña sube la versión de sesión y quita el bloqueo', () => {
    const u = user();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) u.registerFailedLogin();
    u.changePassword('nuevo-hash');
    expect(u.passwordHash).toBe('nuevo-hash');
    expect(u.tokenVersion).toBe(1);
    expect(u.isLocked()).toBe(false);
  });

  it('un inicio de sesión correcto reinicia el contador', () => {
    const u = user();
    u.registerFailedLogin();
    u.registerFailedLogin();
    u.registerSuccessfulLogin();
    expect(u.failedLogins).toBe(0);
  });
});

describe('Business', () => {
  it('se edita con las mismas reglas de creación y conserva dueño e ID', () => {
    const b = Business.create({ ownerId: 'u1', name: 'Café Galeras', category: 'cafeteria', city: 'Pasto' });
    const id = b.id;
    b.update({ name: '  Café Galeras Centro ', city: '' });
    expect(b.name).toBe('Café Galeras Centro');
    expect(b.city).toBeNull();
    expect(b.category).toBe('cafeteria');
    expect([b.id, b.ownerId]).toEqual([id, 'u1']);
    expect(() => b.update({ name: 'X' })).toThrow(ValidationError);
    expect(b.name).toBe('Café Galeras Centro'); // un cambio inválido no deja la entidad a medias
  });

  it('solo su dueño puede operarlo (y el error no revela que existe)', () => {
    const b = Business.create({ ownerId: 'u1', name: 'Café Galeras', category: 'cafeteria' });
    expect(() => b.assertOwnedBy('u1')).not.toThrow();
    expect(() => b.assertOwnedBy('u2')).toThrow(NotFoundError);
  });
});

describe('AnalysisRun (máquina de estados)', () => {
  it('sigue el flujo pending → running → completed', () => {
    const run = AnalysisRun.request({ businessId: 'b', provider: 'test', reviewCount: 3 });
    expect(run.status).toBe('pending');
    run.start();
    run.complete();
    expect(run.status).toBe('completed');
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it('impide transiciones inválidas', () => {
    const run = AnalysisRun.request({ businessId: 'b', provider: 'test', reviewCount: 3 });
    expect(() => run.complete()).toThrow(ConflictError);
    run.start();
    run.fail('boom');
    expect(() => run.start()).toThrow(ConflictError);
  });
});

describe('InsightAggregator', () => {
  const aggregator = new InsightAggregator();
  const reviews = [
    { id: '1', content: 'Se demoraron una hora', rating: 1 },
    { id: '2', content: 'Muy lento el servicio', rating: 2 },
    { id: '3', content: 'Delicioso el café', rating: 5 },
    { id: '4', content: 'Rico pero demorado', rating: 3 },
  ];
  const topics = [
    { key: 'espera', name: 'Tiempo de espera', description: '' },
    { key: 'sabor', name: 'Sabor', description: '' },
    { key: 'precio', name: 'Precio', description: '' },
  ];
  const classifications = [
    { reviewId: '1', sentiment: Sentiment.of('negative', -0.9), topicKeys: ['espera'] },
    { reviewId: '2', sentiment: Sentiment.of('negative', -0.6), topicKeys: ['espera'] },
    { reviewId: '3', sentiment: Sentiment.of('positive', 0.9), topicKeys: ['sabor'] },
    { reviewId: '4', sentiment: Sentiment.of('neutral', 0), topicKeys: ['espera', 'sabor'] },
    { reviewId: 'fantasma', sentiment: Sentiment.of('negative', -1), topicKeys: ['precio'] },
  ];

  it('calcula porcentajes en código e ignora IDs que no existen', () => {
    const stats = aggregator.aggregate(reviews, topics, classifications);
    expect(stats.totalReviews).toBe(4);
    expect(stats.sentiment).toMatchObject({ positive: 1, neutral: 1, negative: 2 });

    const espera = stats.topics[0]!;
    expect(espera.key).toBe('espera');
    expect(espera.mentions).toBe(3);
    expect(espera.share).toBe(75);
    expect(espera.complaintShare).toBe(50);
    expect(espera.sampleQuotes[0]).toBe('Se demoraron una hora');
    // "precio" solo lo mencionaba el ID fantasma: no debe aparecer.
    expect(stats.topics.map((t) => t.key)).not.toContain('precio');
  });

  it('ordena recomendaciones por prioridad y evidencia, y adjunta la cifra real', () => {
    const stats = aggregator.aggregate(reviews, topics, classifications);
    const ranked = aggregator.rankRecommendations(
      [
        { title: 'Destaca el sabor', detail: '', priority: 'baja', topicKey: 'sabor' },
        { title: 'Reduce la espera', detail: '', priority: 'alta', topicKey: 'espera' },
        { title: 'Tema inventado', detail: '', priority: 'media', topicKey: 'no_existe' },
      ],
      stats,
    );
    expect(ranked.map((r) => r.title)).toEqual(['Reduce la espera', 'Tema inventado', 'Destaca el sabor']);
    expect(ranked[0]!.evidenceShare).toBe(50);
    expect(ranked[1]!.topicKey).toBeNull();
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});
