import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { type EvaluationReport, evaluateSentiment, type LabeledPrediction } from '../application/evaluation/SentimentMetrics.js';
import type { ReviewText } from '../domain/model/Insight.js';
import type { ReviewAnalyzer } from '../domain/ports/ReviewAnalyzer.js';
import { SENTIMENT_LABELS, type SentimentLabel } from '../domain/value-objects/Sentiment.js';
import { GeminiReviewAnalyzer } from '../infrastructure/ai/GeminiReviewAnalyzer.js';
import { HeuristicReviewAnalyzer } from '../infrastructure/ai/HeuristicReviewAnalyzer.js';

/**
 * Evalúa la exactitud del sentimiento de cada motor contra reseñas etiquetadas a mano.
 *
 *   npm run eval                    → solo texto (las estrellas delatarían el sarcasmo)
 *   npm run eval -- --con-estrellas → también pasa la calificación al motor
 *   npm run eval -- --guardar       → además escribe docs/EVALUACION.md
 *
 * Si hay GEMINI_API_KEY en el entorno también evalúa Gemini; si no, solo el léxico local.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.resolve(here, '../../samples/evaluacion_sentimiento.csv');
const REPORT = path.resolve(here, '../../docs/EVALUACION.md');
const silent = { info() {}, warn() {}, error() {} };

interface Row {
  comentario: string;
  calificacion: string;
  esperado: SentimentLabel;
  tipo: string;
}

async function run(analyzer: ReviewAnalyzer, rows: Row[], withStars: boolean): Promise<LabeledPrediction[]> {
  const texts: ReviewText[] = rows.map((r, i) => ({
    id: String(i),
    content: r.comentario,
    rating: withStars ? Number(r.calificacion) : null,
  }));
  const topics = [{ key: 'general', name: 'General', description: 'Cualquier aspecto del negocio' }];
  const predicted = new Map<string, SentimentLabel>();
  for (let i = 0; i < texts.length; i += analyzer.batchSize) {
    for (const c of await analyzer.classify(texts.slice(i, i + analyzer.batchSize), topics)) predicted.set(c.reviewId, c.sentiment.label);
  }
  return rows.map((r, i) => ({ expected: r.esperado, predicted: predicted.get(String(i)) ?? null, kind: r.tipo }));
}

const pct = (n: number) => `${(n * 100).toFixed(1)} %`;

function toMarkdown(results: { name: string; report: EvaluationReport }[], withStars: boolean): string {
  const kinds = [...new Set(results.flatMap((r) => Object.keys(r.report.accuracyByKind)))].sort();
  const lines = [
    '# Evaluación del análisis de sentimiento',
    '',
    `Conjunto: \`samples/evaluacion_sentimiento.csv\` (${results[0]?.report.total ?? 0} reseñas etiquetadas a mano).`,
    `Modo: ${withStars ? 'texto + calificación en estrellas' : 'solo texto (sin estrellas)'}. Generado con \`npm run eval -- --guardar\`.`,
    '',
    '## Resumen',
    '',
    `| Motor | Exactitud | F1 macro |`,
    `|---|---|---|`,
    ...results.map((r) => `| ${r.name} | ${pct(r.report.accuracy)} | ${r.report.macroF1.toFixed(3)} |`),
    '',
    '## Exactitud por tipo de caso',
    '',
    `| Tipo | ${results.map((r) => r.name).join(' | ')} |`,
    `|---|${results.map(() => '---').join('|')}|`,
    ...kinds.map(
      (k) =>
        `| ${k} | ${results
          .map((r) => {
            const v = r.report.accuracyByKind[k];
            return v ? `${v.correct}/${v.total}` : '—';
          })
          .join(' | ')} |`,
    ),
  ];
  for (const r of results) {
    lines.push('', `## ${r.name}: métricas por clase`, '', '| Clase | Precisión | Cobertura | F1 | Casos |', '|---|---|---|---|---|');
    for (const l of SENTIMENT_LABELS) {
      const m = r.report.perClass[l];
      lines.push(`| ${l} | ${m.precision.toFixed(3)} | ${m.recall.toFixed(3)} | ${m.f1.toFixed(3)} | ${m.support} |`);
    }
    lines.push(
      '',
      'Matriz de confusión (filas = esperado, columnas = predicho):',
      '',
      '| | positive | neutral | negative | sin respuesta |',
      '|---|---|---|---|---|',
    );
    for (const e of SENTIMENT_LABELS) {
      const row = r.report.confusion[e];
      lines.push(`| **${e}** | ${row.positive} | ${row.neutral} | ${row.negative} | ${row.missing} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const withStars = process.argv.includes('--con-estrellas');
  const rows = parse(await readFile(DATASET, 'utf8'), {
    columns: true,
    delimiter: ';',
    bom: true,
    trim: true,
    skip_empty_lines: true,
  }) as Row[];

  const engines: { name: string; analyzer: ReviewAnalyzer }[] = [{ name: 'Léxico local', analyzer: new HeuristicReviewAnalyzer() }];
  const key = process.env.GEMINI_API_KEY?.trim();
  if (key) {
    const model = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash';
    engines.push({ name: `Gemini (${model})`, analyzer: new GeminiReviewAnalyzer(key, model, process.env.GEMINI_FALLBACK_MODEL, silent) });
  } else {
    console.log('Sin GEMINI_API_KEY: solo se evalúa el léxico local.');
  }

  const results: { name: string; report: EvaluationReport }[] = [];
  for (const e of engines) {
    const t = Date.now();
    const report = evaluateSentiment(await run(e.analyzer, rows, withStars));
    results.push({ name: e.name, report });
    console.log(
      `${e.name.padEnd(28)} exactitud ${pct(report.accuracy).padStart(8)} · F1 macro ${report.macroF1.toFixed(3)} · ${Date.now() - t} ms`,
    );
  }

  const markdown = toMarkdown(results, withStars);
  if (process.argv.includes('--guardar')) {
    await writeFile(REPORT, markdown, 'utf8');
    console.log(`Reporte guardado en ${path.relative(process.cwd(), REPORT)}`);
  } else {
    console.log(`\n${markdown}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
