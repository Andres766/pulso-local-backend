import type {
  BusinessContext,
  InsightStats,
  RecommendationDraft,
  ReviewClassification,
  ReviewText,
  TopicDefinition,
} from '../../domain/model/Insight.js';
import type { ReviewAnalyzer } from '../../domain/ports/ReviewAnalyzer.js';
import { Sentiment } from '../../domain/value-objects/Sentiment.js';

interface CatalogTopic extends TopicDefinition {
  stems: string[];
  advice: { title: string; action: string };
}

/**
 * Estrategia de respaldo SIN red ni costo: léxico de sentimiento en español con manejo
 * de negaciones e intensificadores, y un catálogo de temas por palabras clave.
 * Sirve para desarrollo, pruebas automáticas y para que la app funcione aunque
 * no haya clave de API. Es menos precisa que el LLM (no entiende sarcasmo ni contexto).
 */
export class HeuristicReviewAnalyzer implements ReviewAnalyzer {
  readonly providerName = 'heuristico:lexico-es-v1';
  readonly batchSize = 200;

  private static readonly POSITIVE = [
    'excelente', 'delicios', 'rico', 'rica', 'buen', 'buena', 'bueno', 'amable', 'recomiend', 'encant',
    'perfect', 'rapid', 'limpi', 'agradable', 'acogedor', 'feliz', 'genial', 'mejor', 'fresc', 'calid',
    'atent', 'sabros', 'vale la pena', 'economic', 'justo', 'gust', 'maravill', 'increible', 'top', 'super bien',
  ];

  private static readonly NEGATIVE = [
    'mal', 'mala', 'malo', 'pesim', 'horrible', 'terrible', 'demor', 'lent', 'tarde', 'sucio', 'suci',
    'caro', 'cara', 'costos', 'frio', 'fria', 'grosero', 'grosera', 'groser', 'nunca', 'queja', 'decepcion',
    'desagrad', 'crudo', 'quemad', 'incomod', 'ruido', 'olvid', 'equivoc', 'error', 'espere', 'esperar',
    'insipid', 'feo', 'fea', 'peor', 'estafa', 'cobraron de mas', 'no volvere', 'no vuelvo', 'desorden',
  ];

  private static readonly NEGATIONS = new Set(['no', 'nunca', 'ni', 'nada', 'tampoco', 'sin', 'jamas']);
  private static readonly INTENSIFIERS = new Set(['muy', 'super', 'demasiado', 'bastante', 're', 'tan', 'extremadamente']);

  private static readonly CATALOG: CatalogTopic[] = [
    {
      key: 'atencion', name: 'Atención del personal', description: 'Trato, amabilidad y disposición de quien atiende.',
      stems: ['atencion', 'atendi', 'amable', 'mesero', 'mesera', 'personal', 'trato', 'grosero', 'grosera', 'cajer', 'vendedor', 'atent', 'servicio al cliente'],
      advice: { title: 'Refuerza el protocolo de atención', action: 'Haz una reunión corta con el equipo para acordar un saludo, tiempos de respuesta y cómo manejar reclamos.' },
    },
    {
      key: 'tiempo_espera', name: 'Tiempo de espera', description: 'Demoras para ser atendido o recibir el pedido.',
      stems: ['demor', 'tarde', 'espera', 'esper', 'lent', 'rapid', 'minutos', 'una hora', 'tardaron', 'tardo'],
      advice: { title: 'Reduce la espera en horas pico', action: 'Mide cuánto tarda cada pedido en las horas de más movimiento y refuerza el personal o prepara con anticipación lo más pedido.' },
    },
    {
      key: 'precio', name: 'Precio y valor', description: 'Percepción de precios y relación calidad-precio.',
      stems: ['precio', 'caro', 'cara', 'costos', 'barat', 'economic', 'cobr', 'vale la pena', 'plata', 'cuenta'],
      advice: { title: 'Comunica mejor el valor de tus precios', action: 'Revisa las porciones frente a la competencia y crea un combo o promoción de entrada para quienes sienten que es caro.' },
    },
    {
      key: 'calidad_producto', name: 'Calidad del producto', description: 'Sabor, frescura y estado de lo que se vende.',
      stems: ['sabor', 'delicios', 'rico', 'rica', 'frio', 'fria', 'fresc', 'calidad', 'comida', 'cafe', 'producto', 'quemad', 'crudo', 'sabros', 'insipid', 'porcion'],
      advice: { title: 'Estandariza la preparación', action: 'Define recetas y temperaturas de servicio por escrito y revisa los platos antes de que salgan.' },
    },
    {
      key: 'limpieza', name: 'Limpieza e higiene', description: 'Aseo del local, baños y manipulación de alimentos.',
      stems: ['limpi', 'sucio', 'suci', 'bano', 'higien', 'mosca', 'olor', 'aseo', 'mugre'],
      advice: { title: 'Implementa una rutina de aseo visible', action: 'Crea una lista de chequeo de limpieza por turnos (baños y mesas) y déjala a la vista de los clientes.' },
    },
    {
      key: 'ambiente', name: 'Ambiente del local', description: 'Comodidad, ruido, música y espacio.',
      stems: ['ambiente', 'musica', 'ruido', 'acogedor', 'decoracion', 'espacio', 'incomod', 'lugar', 'sillas', 'mesas', 'bonito'],
      advice: { title: 'Mejora la comodidad del espacio', action: 'Ajusta el volumen de la música y revisa sillas y distribución de mesas para las visitas largas.' },
    },
    {
      key: 'domicilios', name: 'Domicilios', description: 'Pedidos a domicilio y por aplicaciones.',
      stems: ['domicilio', 'delivery', 'pedido', 'rappi', 'llego', 'app', 'whatsapp'],
      advice: { title: 'Controla la calidad de los domicilios', action: 'Usa empaques que conserven la temperatura y confirma cada pedido por WhatsApp antes de despacharlo.' },
    },
    {
      key: 'medios_pago', name: 'Medios de pago', description: 'Formas de pago disponibles y facturación.',
      stems: ['tarjeta', 'datafono', 'nequi', 'daviplata', 'efectivo', 'transferencia', 'factura', 'pago'],
      advice: { title: 'Amplía los medios de pago', action: 'Habilita pagos por Nequi/Daviplata o datáfono y anúncialo en caja y redes.' },
    },
  ];

  async discoverTopics(): Promise<TopicDefinition[]> {
    return HeuristicReviewAnalyzer.CATALOG.map(({ key, name, description }) => ({ key, name, description }));
  }

  async classify(batch: readonly ReviewText[]): Promise<ReviewClassification[]> {
    return batch.map((review) => {
      const text = HeuristicReviewAnalyzer.normalize(review.content);
      const lexical = HeuristicReviewAnalyzer.lexicalScore(text);
      // Si hay estrellas, se combinan con el texto (el texto pesa más).
      const score = review.rating ? 0.6 * lexical + 0.4 * ((review.rating - 3) / 2) : lexical;
      const topicKeys = HeuristicReviewAnalyzer.CATALOG.filter((t) => t.stems.some((s) => text.includes(s))).map((t) => t.key);
      return { reviewId: review.id, sentiment: Sentiment.fromScore(score), topicKeys };
    });
  }

  async recommend(stats: InsightStats, context: BusinessContext): Promise<RecommendationDraft[]> {
    const catalog = new Map(HeuristicReviewAnalyzer.CATALOG.map((t) => [t.key, t]));
    const drafts: RecommendationDraft[] = [...stats.topics]
      .filter((t) => t.negative > 0)
      .sort((a, b) => b.complaintShare - a.complaintShare)
      .slice(0, 4)
      .map((t) => {
        const advice = catalog.get(t.key)?.advice;
        return {
          title: advice?.title ?? `Atiende las quejas sobre ${t.name.toLowerCase()}`,
          detail: `El ${t.complaintShare}% de tus reseñas se queja de ${t.name.toLowerCase()} (${t.negative} de ${stats.totalReviews}). ${advice?.action ?? ''}`.trim(),
          priority: t.complaintShare >= 20 ? 'alta' : t.complaintShare >= 10 ? 'media' : 'baja',
          topicKey: t.key,
        };
      });

    const strength = [...stats.topics].sort((a, b) => b.positive - a.positive)[0];
    if (strength && strength.positive > 0) {
      drafts.push({
        title: `Destaca tu fortaleza: ${strength.name.toLowerCase()}`,
        detail: `${strength.positive} clientes elogian ${strength.name.toLowerCase()}. Úsalo en tus redes y en la vitrina de ${context.name} para atraer nuevos clientes.`,
        priority: 'baja',
        topicKey: strength.key,
      });
    }
    return drafts;
  }

  /**
   * Puntaje léxico en [-1, 1] con ventana de negación de 3 palabras e intensificadores.
   * La negación no cruza signos de puntuación: en "no tenía efectivo, pésimo" el "no"
   * pertenece a otra cláusula y no invierte "pésimo".
   */
  static lexicalScore(text: string): number {
    const tokens = text
      .split(/[.,;:!?¡¿()\n]+/)
      .flatMap((clause) => [...clause.split(/[^a-zñ]+/).filter(Boolean), '|']);
    let score = 0;
    let hits = 0;

    const phrases = (list: string[], sign: number) => {
      for (const p of list.filter((w) => w.includes(' '))) {
        if (text.includes(p)) { score += sign; hits++; }
      }
    };
    phrases(HeuristicReviewAnalyzer.POSITIVE, 1);
    phrases(HeuristicReviewAnalyzer.NEGATIVE, -1);

    tokens.forEach((token, i) => {
      const polarity = HeuristicReviewAnalyzer.polarity(token);
      if (polarity === 0) return;
      const before = tokens.slice(Math.max(0, i - 3), i);
      const window = before.slice(before.lastIndexOf('|') + 1);
      const negated = window.some((w) => HeuristicReviewAnalyzer.NEGATIONS.has(w));
      const intensified = window.some((w) => HeuristicReviewAnalyzer.INTENSIFIERS.has(w));
      // "nunca" y "sin" también están en el léxico negativo; no se cuentan dos veces.
      if (HeuristicReviewAnalyzer.NEGATIONS.has(token)) return;
      score += (negated ? -polarity : polarity) * (intensified ? 1.5 : 1);
      hits++;
    });

    return hits === 0 ? 0 : Math.max(-1, Math.min(1, score / Math.sqrt(hits * 2)));
  }

  private static polarity(token: string): number {
    const single = (list: string[]) => list.some((w) => !w.includes(' ') && token.startsWith(w));
    if (single(HeuristicReviewAnalyzer.NEGATIVE)) return -1;
    if (single(HeuristicReviewAnalyzer.POSITIVE)) return 1;
    return 0;
  }

  static normalize(text: string): string {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
}
