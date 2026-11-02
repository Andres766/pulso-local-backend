import { randomUUID } from 'node:crypto';
import { NotFoundError, ValidationError } from '../errors/DomainError.js';

export const BUSINESS_CATEGORIES = ['restaurante', 'cafeteria', 'tienda', 'belleza', 'servicios', 'salud', 'otro'] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export interface BusinessProps {
  id: string;
  ownerId: string;
  name: string;
  category: BusinessCategory;
  city: string | null;
  createdAt: Date;
}

export interface BusinessDetails {
  name: string;
  category: BusinessCategory;
  city?: string | null;
}

export class Business {
  private constructor(private props: BusinessProps) {}

  static create(input: BusinessDetails & { ownerId: string }): Business {
    return new Business({
      id: randomUUID(),
      ownerId: input.ownerId,
      ...Business.validate(input),
      createdAt: new Date(),
    });
  }

  /**
   * Cambia los datos editables. El dueño y el ID son inmutables: no se pueden "transferir"
   * negocios por esta vía. Las mismas reglas de create() aplican a la edición.
   */
  update(changes: Partial<BusinessDetails>): void {
    this.props = {
      ...this.props,
      ...Business.validate({
        name: changes.name ?? this.props.name,
        category: changes.category ?? this.props.category,
        city: changes.city === undefined ? this.props.city : changes.city,
      }),
    };
  }

  private static validate(input: BusinessDetails): Pick<BusinessProps, 'name' | 'category' | 'city'> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 120) {
      throw new ValidationError('El nombre del negocio debe tener entre 2 y 120 caracteres');
    }
    if (!BUSINESS_CATEGORIES.includes(input.category)) {
      throw new ValidationError('Categoría de negocio no válida');
    }
    return { name, category: input.category, city: input.city?.trim() || null };
  }

  static restore(props: BusinessProps): Business {
    return new Business(props);
  }

  get id(): string {
    return this.props.id;
  }
  get ownerId(): string {
    return this.props.ownerId;
  }
  get name(): string {
    return this.props.name;
  }
  get category(): BusinessCategory {
    return this.props.category;
  }
  get city(): string | null {
    return this.props.city;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /**
   * Regla de autorización del dominio (multi-tenant): un usuario solo opera sus negocios.
   * Responde "no encontrado" en vez de "prohibido" para no revelar que el ID existe.
   */
  assertOwnedBy(userId: string): void {
    if (this.props.ownerId !== userId) {
      throw new NotFoundError('Negocio no encontrado');
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      city: this.city,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
