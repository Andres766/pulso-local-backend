import jwt from 'jsonwebtoken';
import type { TokenPayload, TokenService } from '../../domain/ports/Services.js';

const ISSUER = 'pulsolocal-api';
const AUDIENCE = 'pulsolocal-web';

/**
 * JWT firmado con HS256. Se fija el algoritmo al verificar (evita el ataque "alg: none"
 * o la confusión de algoritmos) y se validan emisor, audiencia y vencimiento.
 */
export class JwtTokenService implements TokenService {
  constructor(
    private readonly secret: string,
    private readonly expiresInHours: number,
  ) {}

  sign(payload: TokenPayload): string {
    return jwt.sign({ email: payload.email }, this.secret, {
      algorithm: 'HS256',
      subject: payload.sub,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: `${this.expiresInHours}h`,
    });
  }

  verify(token: string): TokenPayload | null {
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
      if (typeof decoded === 'string' || typeof decoded.sub !== 'string' || typeof decoded.email !== 'string') {
        return null;
      }
      return { sub: decoded.sub, email: decoded.email };
    } catch {
      return null;
    }
  }

  get maxAgeMs(): number {
    return this.expiresInHours * 3_600_000;
  }
}
