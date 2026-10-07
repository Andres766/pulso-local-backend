import { Review, type ReviewSource } from '../../../domain/entities/Review.js';
import type { ReviewFilter, ReviewRepository, ReviewWithInsight } from '../../../domain/ports/Repositories.js';
import { Rating } from '../../../domain/value-objects/Rating.js';
import type { SentimentLabel } from '../../../domain/value-objects/Sentiment.js';
import type { Database } from '../Database.js';

interface ReviewRow {
  id: string;
  business_id: string;
  content: string;
  content_hash: string;
  rating: number | null;
  source: ReviewSource;
  authored_at: Date | null;
  created_at: Date;
}

interface ReviewInsightRow extends ReviewRow {
  sentiment: SentimentLabel | null;
  score: number | null;
  topics: string[] | null;
  total: string;
}

const INSERT_CHUNK = 500;

export class PgReviewRepository implements ReviewRepository {
  constructor(private readonly db: Database) {}

  async saveMany(reviews: readonly Review[]): Promise<number> {
    if (reviews.length === 0) return 0;
    return this.db.transaction(async (client) => {
      let inserted = 0;
      for (let i = 0; i < reviews.length; i += INSERT_CHUNK) {
        const chunk = reviews.slice(i, i + INSERT_CHUNK);
        // Inserción masiva con UNNEST: una sola consulta parametrizada por bloque.
        const result = await client.query(
          `INSERT INTO reviews (id, business_id, content, content_hash, rating, source, authored_at, created_at)
           SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::char(64)[], $5::smallint[],
                                $6::varchar[], $7::timestamptz[], $8::timestamptz[])
           ON CONFLICT ON CONSTRAINT uq_reviews_business_hash DO NOTHING`,
          [
            chunk.map((r) => r.id),
            chunk.map((r) => r.businessId),
            chunk.map((r) => r.content),
            chunk.map((r) => r.contentHash),
            chunk.map((r) => r.rating?.value ?? null),
            chunk.map((r) => r.source),
            chunk.map((r) => r.authoredAt),
            chunk.map((r) => r.createdAt),
          ],
        );
        inserted += result.rowCount ?? 0;
      }
      return inserted;
    });
  }

  async countByBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>('SELECT count(*) FROM reviews WHERE business_id = $1', [businessId]);
    return Number(rows[0]?.count ?? 0);
  }

  async listForAnalysis(businessId: string, limit: number): Promise<Review[]> {
    const { rows } = await this.db.query<ReviewRow>(
      `SELECT * FROM reviews WHERE business_id = $1
       ORDER BY COALESCE(authored_at, created_at) DESC LIMIT $2`,
      [businessId, limit],
    );
    return rows.map(PgReviewRepository.toDomain);
  }

  /**
   * Consulta de lectura: cada reseña con el sentimiento y temas del ÚLTIMO análisis completado.
   * Los filtros opcionales se agregan como parámetros ($n), nunca interpolando texto del usuario.
   */
  async search(businessId: string, filter: ReviewFilter): Promise<{ items: ReviewWithInsight[]; total: number }> {
    const params: unknown[] = [businessId];
    const conditions: string[] = ['r.business_id = $1'];

    if (filter.sentiment) {
      params.push(filter.sentiment);
      conditions.push(`rs.sentiment = $${params.length}`);
    }
    if (filter.topicKey) {
      params.push(filter.topicKey);
      conditions.push(`EXISTS (SELECT 1 FROM review_topics rt JOIN topics t ON t.id = rt.topic_id
                               WHERE rt.review_id = r.id AND t.run_id = lr.id AND t.key = $${params.length})`);
    }
    if (filter.search) {
      // Escapa comodines de LIKE para que el texto del usuario se busque literal.
      params.push(`%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      conditions.push(`r.content ILIKE $${params.length}`);
    }
    params.push(filter.limit, filter.offset);

    const { rows } = await this.db.query<ReviewInsightRow>(
      `WITH lr AS (
         SELECT id FROM analysis_runs
         WHERE business_id = $1 AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1
       )
       SELECT r.*, rs.sentiment, rs.score,
              (SELECT array_agg(t.name ORDER BY t.name) FROM review_topics rt
                 JOIN topics t ON t.id = rt.topic_id
                WHERE rt.review_id = r.id AND t.run_id = lr.id) AS topics,
              count(*) OVER () AS total
         FROM reviews r
         LEFT JOIN lr ON true
         LEFT JOIN review_sentiments rs ON rs.review_id = r.id AND rs.run_id = lr.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(r.authored_at, r.created_at) DESC, r.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      total: rows[0] ? Number(rows[0].total) : 0,
      items: rows.map((row) => ({
        review: PgReviewRepository.toDomain(row),
        sentiment: row.sentiment,
        sentimentScore: row.score,
        topics: row.topics ?? [],
      })),
    };
  }

  async deleteAll(businessId: string): Promise<number> {
    const result = await this.db.query('DELETE FROM reviews WHERE business_id = $1', [businessId]);
    return result.rowCount ?? 0;
  }

  private static toDomain(row: ReviewRow): Review {
    return Review.restore({
      id: row.id,
      businessId: row.business_id,
      content: row.content,
      contentHash: row.content_hash,
      rating: row.rating === null ? null : Rating.create(row.rating),
      source: row.source,
      authoredAt: row.authored_at,
      createdAt: row.created_at,
    });
  }
}
