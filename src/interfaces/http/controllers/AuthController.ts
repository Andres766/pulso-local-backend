import type { CookieOptions, Request, Response } from 'express';
import type { AuthenticateUser } from '../../../application/use-cases/auth/AuthenticateUser.js';
import type { GetCurrentUser } from '../../../application/use-cases/auth/GetCurrentUser.js';
import type { RegisterUser } from '../../../application/use-cases/auth/RegisterUser.js';
import { SESSION_COOKIE } from '../middlewares/security.js';
import { loginSchema, registerSchema } from '../schemas.js';

/**
 * Controladores delgados: validan la entrada, llaman al caso de uso y dan forma a la respuesta.
 * No contienen reglas de negocio.
 */
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUser,
    private readonly authenticateUser: AuthenticateUser,
    private readonly getCurrentUser: GetCurrentUser,
    private readonly cookie: { secure: boolean; maxAgeMs: number },
  ) {}

  register = async (req: Request, res: Response) => {
    const input = registerSchema.parse(req.body);
    await this.registerUser.execute(input);
    // Tras registrarse se inicia sesión directamente.
    const { user, token } = await this.authenticateUser.execute(input);
    this.setSession(res, token);
    res.status(201).json({ user: user.toPublic() });
  };

  login = async (req: Request, res: Response) => {
    const { user, token } = await this.authenticateUser.execute(loginSchema.parse(req.body));
    this.setSession(res, token);
    res.json({ user: user.toPublic() });
  };

  logout = (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    res.status(204).end();
  };

  me = async (req: Request, res: Response) => {
    const user = await this.getCurrentUser.execute(req.userId!);
    res.json({ user: user.toPublic() });
  };

  private setSession(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: this.cookie.maxAgeMs });
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.cookie.secure, sameSite: 'strict', path: '/api' };
  }
}
