import type { Business } from '../../../domain/entities/Business.js';
import { NotFoundError } from '../../../domain/errors/DomainError.js';
import type { BusinessRepository } from '../../../domain/ports/Repositories.js';

/**
 * Punto único de control de acceso a un negocio. TODOS los casos de uso que reciben
 * un businessId pasan por aquí, así no hay forma de olvidar la verificación de dueño
 * (previene IDOR: Insecure Direct Object Reference).
 */
export class BusinessAccess {
  constructor(private readonly businesses: BusinessRepository) {}

  async requireOwned(businessId: string, userId: string): Promise<Business> {
    const business = await this.businesses.findById(businessId);
    if (!business) throw new NotFoundError('Negocio no encontrado');
    business.assertOwnedBy(userId);
    return business;
  }
}
