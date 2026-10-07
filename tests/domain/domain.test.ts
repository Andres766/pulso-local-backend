import { describe, expect, it } from 'vitest';
import { AnalysisRun } from '../../src/domain/entities/AnalysisRun.js';
import { Business } from '../../src/domain/entities/Business.js';
import { Review } from '../../src/domain/entities/Review.js';
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

describe('Business', () => {
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
