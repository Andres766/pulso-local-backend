import { randomUUID } from 'node:crypto';
import { ConflictError } from '../errors/DomainError.js';

export const ANALYSIS_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export interface AnalysisRunProps {
  id: string;
  businessId: string;
  status: AnalysisStatus;
  provider: string;
  reviewCount: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * Una ejecución del análisis de IA sobre las reseñas de un negocio.
 * Máquina de estados explícita:
 *
 *   pending ──start()──▶ running ──complete()──▶ completed
 *      └──────────────────┴────────fail()──────▶ failed
 *
 * Una transición no permitida lanza ConflictError: el estado nunca queda incoherente.
 */
export class AnalysisRun {
  private static readonly TRANSITIONS: Record<AnalysisStatus, readonly AnalysisStatus[]> = {
    pending: ['running', 'failed'],
    running: ['completed', 'failed'],
    completed: [],
    failed: [],
  };

  private constructor(private props: AnalysisRunProps) {}

  static request(input: { businessId: string; provider: string; reviewCount: number }): AnalysisRun {
    return new AnalysisRun({
      id: randomUUID(),
      businessId: input.businessId,
      status: 'pending',
      provider: input.provider,
      reviewCount: input.reviewCount,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    });
  }

  static restore(props: AnalysisRunProps): AnalysisRun {
    return new AnalysisRun(props);
  }

  start(): void {
    this.transitionTo('running');
    this.props.startedAt = new Date();
  }

  complete(): void {
    this.transitionTo('completed');
    this.props.finishedAt = new Date();
  }

  fail(reason: string): void {
    this.transitionTo('failed');
    this.props.error = reason.slice(0, 500);
    this.props.finishedAt = new Date();
  }

  get isInProgress(): boolean {
    return this.props.status === 'pending' || this.props.status === 'running';
  }

  private transitionTo(next: AnalysisStatus): void {
    const allowed = AnalysisRun.TRANSITIONS[this.props.status];
    if (!allowed.includes(next)) {
      throw new ConflictError(`Transición inválida del análisis: ${this.props.status} → ${next}`);
    }
    this.props.status = next;
  }

  get id(): string { return this.props.id; }
  get businessId(): string { return this.props.businessId; }
  get status(): AnalysisStatus { return this.props.status; }
  get provider(): string { return this.props.provider; }
  get reviewCount(): number { return this.props.reviewCount; }
  get error(): string | null { return this.props.error; }
  get createdAt(): Date { return this.props.createdAt; }
  get startedAt(): Date | null { return this.props.startedAt; }
  get finishedAt(): Date | null { return this.props.finishedAt; }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      provider: this.provider,
      reviewCount: this.reviewCount,
      error: this.error,
      createdAt: this.createdAt.toISOString(),
      startedAt: this.startedAt?.toISOString() ?? null,
      finishedAt: this.finishedAt?.toISOString() ?? null,
    };
  }
}
