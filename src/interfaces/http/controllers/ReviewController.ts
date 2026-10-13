import type { Request, Response } from 'express';
import type {
  ClearReviews,
  ExportReviews,
  ImportReviews,
  ListReviews,
} from '../../../application/use-cases/reviews/ReviewUseCases.js';
import { ValidationError } from '../../../domain/errors/DomainError.js';
import type { CsvReviewExporter } from '../../../infrastructure/csv/CsvReviewExporter.js';
import type { ReviewSourceParser } from '../../../infrastructure/csv/ReviewTextParsers.js';
import { listReviewsQuery, pasteReviewsSchema, uuidParam } from '../schemas.js';

export class ReviewController {
  constructor(
    private readonly importReviews: ImportReviews,
    private readonly listReviews: ListReviews,
    private readonly clearReviews: ClearReviews,
    private readonly exportReviews: ExportReviews,
    private readonly csvParser: ReviewSourceParser,
    private readonly textParser: ReviewSourceParser,
    private readonly exporter: CsvReviewExporter,
  ) {}

  list = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const q = listReviewsQuery.parse(req.query);
    const page = await this.listReviews.execute(id, req.userId!, {
      sentiment: q.sentiment,
      topicKey: q.topic,
      search: q.q || undefined,
      limit: q.limit,
      offset: q.offset,
    });
    res.json({
      total: page.total,
      items: page.items.map((i) => ({ ...i.review.toJSON(), sentiment: i.sentiment, sentimentScore: i.sentimentScore, topics: i.topics })),
    });
  };

  /** Carga por archivo CSV (multipart/form-data, campo "file"). */
  uploadCsv = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    if (!req.file) throw new ValidationError('Adjunta un archivo CSV en el campo "file"');
    const text = ReviewController.decodeUtf8(req.file.buffer);
    const summary = await this.importReviews.execute(id, req.userId!, this.csvParser.parse(text), 'csv');
    res.status(201).json(summary);
  };

  /** Carga de texto pegado (una reseña por línea). */
  paste = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const { text } = pasteReviewsSchema.parse(req.body);
    const summary = await this.importReviews.execute(id, req.userId!, this.textParser.parse(text), 'manual');
    res.status(201).json(summary);
  };

  /** Descarga CSV con el sentimiento y los temas del último análisis. */
  exportCsv = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const { businessName, items } = await this.exportReviews.execute(id, req.userId!);
    const filename = `resenas-${ReviewController.slug(businessName)}-${new Date().toISOString().slice(0, 10)}.csv`;
    res
      .type('text/csv; charset=utf-8')
      .attachment(filename)
      .send(this.exporter.serialize(items));
  };

  clear = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const deleted = await this.clearReviews.execute(id, req.userId!);
    res.json({ deleted });
  };

  /** Nombre de archivo seguro: solo letras, números y guiones (sin rutas ni comillas en la cabecera). */
  private static slug(text: string): string {
    return (
      text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'negocio'
    );
  }

  /** Rechaza binarios disfrazados de CSV: el contenido debe ser UTF-8 válido y sin bytes nulos. */
  private static decodeUtf8(buffer: Buffer): string {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (text.includes('\u0000')) throw new Error('binario');
      return text;
    } catch {
      throw new ValidationError('El archivo debe ser un CSV de texto en UTF-8');
    }
  }
}
