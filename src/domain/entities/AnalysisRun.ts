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
  /** Cuántas veces se intentó ejecutar (incluye el intento en curso). */
  attempts: number;
  /** No antes de esta fecha: permite reintentar con espera tras un error transitorio. */
  availableAt: Date;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Máximo de intentos por análisis (errores transitorios de la IA o reinicios del servidor). */
export const MAX_ANALYSIS_ATTEMPTS = 3;

/**
 * Una ejecución del análisis de IA sobre las reseñas de un negocio. Es también el
 * elemento de la cola de trabajos (ver AnalysisWorker). Máquina de estados explícita:
 *
 *   pending ──start()──▶ running ──complete()──▶ completed
 *      ▲                    │
 *      └──retryLater()──────┤
 *      └────────────────────┴──────fail()──────▶ failed
 *
 * Una transición no permitida lanza ConflictError: el estado nunca queda incoherente.
 */
export class AnalysisRun {
  private static readonly TRANSITIONS: Record<AnalysisStatus, readonly AnalysisStatus[]> = {
    pending: ['running', 'failed'],
    running: ['completed', 'failed', 'pending'],
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
      attempts: 0,
      availableAt: new Date(),
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
    this.props.attempts += 1;
    this.props.startedAt = new Date();
  }

  /** Devuelve el análisis a la cola para reintentarlo dentro de `delayMs`, conservando el motivo. */
  retryLater(reason: string, delayMs: number): void {
    if (!this.canRetry) {
      throw new ConflictError('El análisis agotó sus intentos');
    }
    this.transitionTo('pending');
    this.props.error = reason.slice(0, 500);
    this.props.startedAt = null;
    this.props.availableAt = new Date(Date.now() + delayMs);
  }

  get canRetry(): boolean {
    return this.props.attempts < MAX_ANALYSIS_ATTEMPTS;
  }

  complete(): void {
    this.transitionTo('completed');
    this.props.error = null; // el motivo de un intento anterior fallido ya no aplica
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

  get id(): string {
    return this.props.id;
  }
  get businessId(): string {
    return this.props.businessId;
  }
  get status(): AnalysisStatus {
    return this.props.status;
  }
  get provider(): string {
    return this.props.provider;
  }
  get reviewCount(): number {
    return this.props.reviewCount;
  }
  get error(): string | null {
    return this.props.error;
  }
  get attempts(): number {
    return this.props.attempts;
  }
  get availableAt(): Date {
    return this.props.availableAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get startedAt(): Date | null {
    return this.props.startedAt;
  }
  get finishedAt(): Date | null {
    return this.props.finishedAt;
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      provider: this.provider,
      reviewCount: this.reviewCount,
      error: this.error,
      attempts: this.attempts,
      createdAt: this.createdAt.toISOString(),
      startedAt: this.startedAt?.toISOString() ?? null,
      finishedAt: this.finishedAt?.toISOString() ?? null,
    };
  }
}
