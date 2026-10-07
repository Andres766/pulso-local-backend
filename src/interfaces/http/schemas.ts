import { z } from 'zod';
import { BUSINESS_CATEGORIES } from '../../domain/entities/Business.js';
import { SENTIMENT_LABELS } from '../../domain/value-objects/Sentiment.js';

/**
 * Esquemas de validación de la frontera HTTP (whitelisting): todo lo que no esté
 * declarado aquí se descarta con .strict() → no hay "mass assignment".
 * El dominio vuelve a validar sus reglas: defensa en profundidad.
 */

export const uuidParam = z.object({ id: z.string().uuid('Identificador no válido') });

export const registerSchema = z
  .object({
    email: z.string().trim().max(254),
    name: z.string().trim().min(2).max(80),
    password: z.string().min(1).max(200),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

export const createBusinessSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    category: z.enum(BUSINESS_CATEGORIES),
    city: z.string().trim().max(80).nullish(),
  })
  .strict();

export const pasteReviewsSchema = z
  .object({
    text: z.string().min(3).max(200_000),
  })
  .strict();

export const listReviewsQuery = z.object({
  sentiment: z.enum(SENTIMENT_LABELS).optional(),
  topic: z
    .string()
    .regex(/^[a-z0-9_]{1,60}$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
