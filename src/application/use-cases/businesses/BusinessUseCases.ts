import { Business, type BusinessCategory } from '../../../domain/entities/Business.js';
import { ValidationError } from '../../../domain/errors/DomainError.js';
import type { BusinessRepository } from '../../../domain/ports/Repositories.js';
import type { BusinessAccess } from './BusinessAccess.js';

export const MAX_BUSINESSES_PER_USER = 10;

export class CreateBusiness {
  constructor(private readonly businesses: BusinessRepository) {}

  async execute(ownerId: string, input: { name: string; category: BusinessCategory; city?: string | null }): Promise<Business> {
    const existing = await this.businesses.listByOwner(ownerId);
    if (existing.length >= MAX_BUSINESSES_PER_USER) {
      throw new ValidationError(`Puedes registrar hasta ${MAX_BUSINESSES_PER_USER} negocios`);
    }
    const business = Business.create({ ownerId, ...input });
    await this.businesses.save(business);
    return business;
  }
}

export class ListBusinesses {
  constructor(private readonly businesses: BusinessRepository) {}

  execute(ownerId: string): Promise<Business[]> {
    return this.businesses.listByOwner(ownerId);
  }
}

export class GetBusiness {
  constructor(private readonly access: BusinessAccess) {}

  execute(businessId: string, userId: string): Promise<Business> {
    return this.access.requireOwned(businessId, userId);
  }
}

export class DeleteBusiness {
  constructor(
    private readonly access: BusinessAccess,
    private readonly businesses: BusinessRepository,
  ) {}

  async execute(businessId: string, userId: string): Promise<void> {
    await this.access.requireOwned(businessId, userId);
    await this.businesses.delete(businessId);
  }
}
