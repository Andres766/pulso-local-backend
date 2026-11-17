import type { Request, Response } from 'express';
import type {
  GetAdminDashboard,
  ListUsersForAdmin,
  RetryFailedAnalysis,
  UnlockUser,
} from '../../../application/use-cases/admin/AdminUseCases.js';
import { uuidParam } from '../schemas.js';

/**
 * Panel de administración. La autorización por rol vive en los casos de uso (AdminAccess), no
 * aquí: así ninguna ruta nueva puede olvidarla. Un usuario normal recibe 403.
 */
export class AdminController {
  constructor(
    private readonly getDashboard: GetAdminDashboard,
    private readonly listUsers: ListUsersForAdmin,
    private readonly unlockUser: UnlockUser,
    private readonly retryAnalysis: RetryFailedAnalysis,
  ) {}

  dashboard = async (req: Request, res: Response) => {
    const d = await this.getDashboard.execute(req.userId!);
    res.json({
      overview: d.overview,
      usage: d.usage,
      failed: d.failed.map((f) => ({ ...f, finishedAt: f.finishedAt?.toISOString() ?? null })),
    });
  };

  users = async (req: Request, res: Response) => {
    const items = await this.listUsers.execute(req.userId!);
    const now = Date.now();
    res.json({
      items: items.map((u) => ({
        ...u,
        createdAt: u.createdAt.toISOString(),
        lockedUntil: u.lockedUntil && u.lockedUntil.getTime() > now ? u.lockedUntil.toISOString() : null,
      })),
    });
  };

  unlock = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const user = await this.unlockUser.execute(req.userId!, id);
    res.json({ user: user.toPublic() });
  };

  retry = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const run = await this.retryAnalysis.execute(req.userId!, id);
    res.status(202).json(run.toJSON());
  };
}
