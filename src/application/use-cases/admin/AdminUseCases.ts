import { AnalysisRun } from '../../../domain/entities/AnalysisRun.js';
import type { User } from '../../../domain/entities/User.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../domain/errors/DomainError.js';
import type {
  AdminReadModel,
  AnalysisRepository,
  DailyUsage,
  FailedAnalysis,
  PlatformOverview,
  ReviewRepository,
  UserRepository,
  UserSummary,
} from '../../../domain/ports/Repositories.js';
import type { ReviewAnalyzer } from '../../../domain/ports/ReviewAnalyzer.js';
import type { JobQueue } from '../../../domain/ports/Services.js';
import type { Email } from '../../../domain/value-objects/Email.js';
import { MAX_REVIEWS_PER_ANALYSIS } from '../analysis/RequestAnalysis.js';

/**
 * Punto único de autorización por rol (RBAC). Todos los casos de uso de administración pasan por
 * aquí, igual que los del dueño pasan por BusinessAccess: el rol se lee de la base en cada petición,
 * así que quitarle el rol a alguien surte efecto de inmediato (no queda "guardado" en el token).
 */
export class AdminAccess {
  constructor(private readonly users: UserRepository) {}

  async requireAdmin(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user?.isAdmin) throw new ForbiddenError('Esta sección es solo para administradores');
    return user;
  }
}

export interface AdminDashboard {
  overview: PlatformOverview;
  usage: DailyUsage[];
  failed: FailedAnalysis[];
}

export const ADMIN_USAGE_DAYS = 14;

/** Estado de la plataforma: cifras, consumo de IA por día y análisis fallidos. */
export class GetAdminDashboard {
  constructor(
    private readonly access: AdminAccess,
    private readonly readModel: AdminReadModel,
  ) {}

  async execute(adminId: string, now = new Date()): Promise<AdminDashboard> {
    await this.access.requireAdmin(adminId);
    const [overview, usage, failed] = await Promise.all([
      this.readModel.overview(now),
      this.readModel.usageByDay(ADMIN_USAGE_DAYS),
      this.readModel.failedAnalyses(10),
    ]);
    return { overview, usage, failed };
  }
}

export class ListUsersForAdmin {
  constructor(
    private readonly access: AdminAccess,
    private readonly readModel: AdminReadModel,
  ) {}

  async execute(adminId: string): Promise<UserSummary[]> {
    await this.access.requireAdmin(adminId);
    return this.readModel.listUsers(200);
  }
}

/** Quita el bloqueo por intentos fallidos de una cuenta. */
export class UnlockUser {
  constructor(
    private readonly access: AdminAccess,
    private readonly users: UserRepository,
  ) {}

  async execute(adminId: string, targetId: string): Promise<User> {
    await this.access.requireAdmin(adminId);
    const user = await this.users.findById(targetId);
    if (!user) throw new NotFoundError('Usuario no encontrado');
    user.unlock();
    await this.users.save(user);
    return user;
  }
}

/**
 * Reintenta un análisis fallido (por ejemplo, cuando la IA estuvo saturada). Crea un análisis nuevo
 * en la cola para el mismo negocio; el dueño lo ve avanzar en vivo si tiene el dashboard abierto.
 */
export class RetryFailedAnalysis {
  constructor(
    private readonly access: AdminAccess,
    private readonly analyses: AnalysisRepository,
    private readonly reviews: ReviewRepository,
    private readonly analyzer: ReviewAnalyzer,
    private readonly queue: JobQueue,
  ) {}

  async execute(adminId: string, runId: string): Promise<AnalysisRun> {
    await this.access.requireAdmin(adminId);
    const failed = await this.analyses.findById(runId);
    if (!failed) throw new NotFoundError('Análisis no encontrado');
    if (failed.status !== 'failed') throw new ConflictError('Solo se pueden reintentar análisis fallidos');

    const latest = await this.analyses.findLatest(failed.businessId);
    if (latest?.isInProgress) throw new ConflictError('Ese negocio ya tiene un análisis en curso');
    const total = await this.reviews.countByBusiness(failed.businessId);
    if (total === 0) throw new ConflictError('El negocio ya no tiene reseñas');

    const run = AnalysisRun.request({
      businessId: failed.businessId,
      provider: this.analyzer.providerName,
      reviewCount: Math.min(total, MAX_REVIEWS_PER_ANALYSIS),
    });
    await this.analyses.save(run);
    this.queue.wake();
    return run;
  }
}

/**
 * Al arrancar, da el rol de administrador a los correos de ADMIN_EMAILS que ya tengan cuenta. Así
 * se nombra un admin en producción sin acceso directo a la base. Solo promueve: quitar el rol es
 * una decisión explícita (npm run make-admin -- correo --quitar).
 */
export class PromoteConfiguredAdmins {
  constructor(private readonly users: UserRepository) {}

  async execute(emails: readonly Email[]): Promise<string[]> {
    const promoted: string[] = [];
    for (const email of emails) {
      const user = await this.users.findByEmail(email);
      if (!user || user.isAdmin) continue;
      user.promoteToAdmin();
      await this.users.save(user);
      promoted.push(email.value);
    }
    return promoted;
  }
}
