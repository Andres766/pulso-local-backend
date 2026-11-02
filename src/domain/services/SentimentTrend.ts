/** Sentimiento de las reseñas escritas en un mes (según el último análisis). */
export interface MonthlySentiment {
  /** Mes en formato AAAA-MM. */
  month: string;
  positive: number;
  neutral: number;
  negative: number;
  total: number;
  averageScore: number | null;
}

const MONTH = /^(\d{4})-(\d{2})$/;

/**
 * Servicio de dominio puro: ordena los meses y rellena los vacíos con ceros entre el primero
 * y el último, para que la serie temporal no "salte" meses sin reseñas (eso falsearía la tendencia).
 */
export class SentimentTrend {
  fillGaps(points: readonly MonthlySentiment[]): MonthlySentiment[] {
    const byMonth = new Map(points.filter((p) => MONTH.test(p.month)).map((p) => [p.month, p]));
    if (byMonth.size === 0) return [];

    const months = [...byMonth.keys()].sort();
    const series: MonthlySentiment[] = [];
    for (let m = months[0]!; m <= months.at(-1)!; m = SentimentTrend.next(m)) {
      series.push(byMonth.get(m) ?? { month: m, positive: 0, neutral: 0, negative: 0, total: 0, averageScore: null });
    }
    return series;
  }

  private static next(month: string): string {
    const [, y, mm] = MONTH.exec(month)!;
    const d = new Date(Date.UTC(Number(y), Number(mm), 1)); // mm (1-12) como índice 0-11 = mes siguiente
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}
