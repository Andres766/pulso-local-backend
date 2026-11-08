/**
 * Contrato de la API en OpenAPI 3.1, servido en GET /api/openapi.json (se puede abrir en
 * https://editor.swagger.io o importar en Postman). Una prueba recorre las rutas registradas en
 * Express y falla si alguna no está documentada aquí, así el contrato no se desactualiza.
 */

const json = (schema: object) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (description: string, schema?: object) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), { description: ERROR_DESCRIPTIONS[c] ?? 'Error', content: json(ref('Error')) }]));

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Datos de entrada inválidos',
  401: 'Sin sesión, sesión vencida o credenciales inválidas',
  403: 'Falta el header anti-CSRF',
  404: 'No existe o no pertenece al usuario (no se distingue a propósito)',
  409: 'El estado actual no lo permite',
  423: 'Cuenta bloqueada temporalmente por intentos fallidos',
  429: 'Límite de peticiones alcanzado',
};

const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const csrf = { $ref: '#/components/parameters/Csrf' };
const authed = [{ cookieSession: [] }];

/** Operación protegida que modifica estado: requiere sesión y el header anti-CSRF. */
const mutation = (summary: string, extra: object = {}) => ({ summary, security: authed, parameters: [csrf], ...extra });

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'PulsoLocal API',
    version: '0.4.0',
    description:
      'Insights automáticos de reseñas para negocios pequeños. La sesión viaja en una cookie httpOnly; ' +
      'toda petición que modifica estado debe enviar el header `X-Requested-With: PulsoLocal` (protección CSRF).',
  },
  servers: [{ url: '/api' }],
  tags: [{ name: 'Sistema' }, { name: 'Autenticación' }, { name: 'Negocios' }, { name: 'Reseñas' }, { name: 'Análisis' }],
  paths: {
    '/health': {
      get: {
        tags: ['Sistema'],
        summary: 'Estado del servicio y versión',
        responses: { 200: ok('En línea'), 503: ok('Base de datos caída') },
      },
    },
    '/openapi.json': { get: { tags: ['Sistema'], summary: 'Este documento', responses: { 200: ok('Contrato OpenAPI') } } },

    '/auth/register': {
      post: {
        tags: ['Autenticación'],
        summary: 'Crear cuenta e iniciar sesión',
        parameters: [csrf],
        requestBody: { required: true, content: json(ref('RegisterInput')) },
        responses: { 201: ok('Cuenta creada; cookie de sesión', ref('UserEnvelope')), ...errors(400, 409, 429) },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Autenticación'],
        summary: 'Iniciar sesión',
        parameters: [csrf],
        requestBody: { required: true, content: json(ref('LoginInput')) },
        responses: { 200: ok('Sesión iniciada; cookie httpOnly', ref('UserEnvelope')), ...errors(401, 423, 429) },
      },
    },
    '/auth/logout': {
      post: { tags: ['Autenticación'], summary: 'Cerrar sesión', parameters: [csrf], responses: { 204: ok('Cookie borrada') } },
    },
    '/auth/me': {
      get: {
        tags: ['Autenticación'],
        summary: 'Usuario actual',
        security: authed,
        responses: { 200: ok('Usuario', ref('UserEnvelope')), ...errors(401) },
      },
    },
    '/auth/password': {
      post: {
        tags: ['Autenticación'],
        ...mutation('Cambiar la contraseña (cierra las demás sesiones)'),
        requestBody: { required: true, content: json(ref('ChangePasswordInput')) },
        responses: { 204: ok('Cambiada; nueva cookie para esta sesión'), ...errors(400, 401, 429) },
      },
    },
    '/auth/account': {
      delete: {
        tags: ['Autenticación'],
        ...mutation('Eliminar la cuenta y todos sus datos (Ley 1581 de 2012)'),
        requestBody: {
          required: true,
          content: json({ type: 'object', required: ['password'], properties: { password: { type: 'string' } } }),
        },
        responses: { 204: ok('Cuenta eliminada'), ...errors(401, 429) },
      },
    },

    '/businesses': {
      get: {
        tags: ['Negocios'],
        summary: 'Mis negocios',
        security: authed,
        responses: {
          200: ok('Lista', { type: 'object', properties: { items: { type: 'array', items: ref('Business') } } }),
          ...errors(401),
        },
      },
      post: {
        tags: ['Negocios'],
        ...mutation('Crear negocio'),
        requestBody: { required: true, content: json(ref('BusinessInput')) },
        responses: { 201: ok('Creado', ref('Business')), ...errors(400, 401, 403) },
      },
    },
    '/businesses/{id}': {
      get: {
        tags: ['Negocios'],
        summary: 'Ver negocio',
        security: authed,
        parameters: [idParam],
        responses: { 200: ok('Negocio', ref('Business')), ...errors(401, 404) },
      },
      patch: {
        tags: ['Negocios'],
        ...mutation('Editar negocio', { parameters: [idParam, csrf] }),
        requestBody: { required: true, content: json(ref('BusinessPatch')) },
        responses: { 200: ok('Actualizado', ref('Business')), ...errors(400, 401, 403, 404) },
      },
      delete: {
        tags: ['Negocios'],
        ...mutation('Eliminar negocio', { parameters: [idParam, csrf] }),
        responses: { 204: ok('Eliminado'), ...errors(401, 403, 404) },
      },
    },

    '/businesses/{id}/reviews': {
      get: {
        tags: ['Reseñas'],
        summary: 'Reseñas con filtros, orden y paginación',
        security: authed,
        parameters: [
          idParam,
          { name: 'sentiment', in: 'query', schema: { enum: ['positive', 'neutral', 'negative'] } },
          { name: 'topic', in: 'query', schema: { type: 'string', pattern: '^[a-z0-9_]{1,60}$' } },
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 } },
          { name: 'rating', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5 } },
          {
            name: 'sort',
            in: 'query',
            schema: { enum: ['recent', 'oldest', 'rating_desc', 'rating_asc', 'most_negative', 'most_positive'] },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          200: ok('Página de reseñas', {
            type: 'object',
            properties: { total: { type: 'integer' }, items: { type: 'array', items: ref('Review') } },
          }),
          ...errors(400, 401, 404),
        },
      },
      delete: {
        tags: ['Reseñas'],
        ...mutation('Borrar todas las reseñas', { parameters: [idParam, csrf] }),
        responses: { 200: ok('Cantidad borrada'), ...errors(401, 403, 404) },
      },
    },
    '/businesses/{id}/reviews/export': {
      get: {
        tags: ['Reseñas'],
        summary: 'Descargar CSV (protegido contra formula injection)',
        security: authed,
        parameters: [idParam],
        responses: { 200: { description: 'Archivo CSV', content: { 'text/csv': { schema: { type: 'string' } } } }, ...errors(401, 404) },
      },
    },
    '/businesses/{id}/reviews/csv': {
      post: {
        tags: ['Reseñas'],
        ...mutation('Importar CSV (máx. 1 MB, UTF-8)', { parameters: [idParam, csrf] }),
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } },
        },
        responses: { 201: ok('Resumen de la importación', ref('ImportSummary')), ...errors(400, 401, 403, 404) },
      },
    },
    '/businesses/{id}/reviews/text': {
      post: {
        tags: ['Reseñas'],
        ...mutation('Importar texto pegado (una reseña por línea)', { parameters: [idParam, csrf] }),
        requestBody: {
          required: true,
          content: json({ type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 200000 } } }),
        },
        responses: { 201: ok('Resumen de la importación', ref('ImportSummary')), ...errors(400, 401, 403, 404) },
      },
    },
    '/businesses/{id}/reviews/{reviewId}': {
      delete: {
        tags: ['Reseñas'],
        ...mutation('Eliminar una reseña', {
          parameters: [idParam, { name: 'reviewId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, csrf],
        }),
        responses: { 204: ok('Eliminada'), ...errors(401, 403, 404) },
      },
    },

    '/businesses/overview': {
      get: {
        tags: ['Análisis'],
        summary: 'Pulso de todos mis negocios: reseñas, sentimiento y principal queja del último análisis',
        security: authed,
        responses: { 200: ok('Resumen por negocio'), ...errors(401) },
      },
    },
    '/businesses/{id}/dashboard': {
      get: {
        tags: ['Análisis'],
        summary: 'Reporte, comparación con el análisis anterior e historial',
        security: authed,
        parameters: [idParam],
        responses: { 200: ok('Dashboard'), ...errors(401, 404) },
      },
    },
    '/businesses/{id}/trend': {
      get: {
        tags: ['Análisis'],
        summary: 'Sentimiento por mes',
        security: authed,
        parameters: [idParam, { name: 'months', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 24, default: 12 } }],
        responses: { 200: ok('Serie mensual'), ...errors(400, 401, 404) },
      },
    },
    '/businesses/{id}/analyses': {
      post: {
        tags: ['Análisis'],
        ...mutation('Lanzar un análisis de IA (queda en la cola persistente)', { parameters: [idParam, csrf] }),
        responses: { 202: ok('Aceptado; consultar GET /analyses/{id}', ref('AnalysisRun')), ...errors(401, 403, 404, 409, 429) },
      },
    },
    '/analyses/{id}': {
      get: {
        tags: ['Análisis'],
        summary: 'Estado de un análisis',
        security: authed,
        parameters: [idParam],
        responses: { 200: ok('Análisis', ref('AnalysisRun')), ...errors(401, 404) },
      },
    },
  },
  components: {
    securitySchemes: {
      cookieSession: { type: 'apiKey', in: 'cookie', name: 'pulso_session', description: 'JWT en cookie httpOnly, SameSite=Strict' },
    },
    parameters: {
      Csrf: { name: 'X-Requested-With', in: 'header', required: true, schema: { const: 'PulsoLocal' }, description: 'Protección CSRF' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string' },
              details: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
      RegisterInput: {
        type: 'object',
        required: ['name', 'email', 'password'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 80 },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 10 },
        },
      },
      LoginInput: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: { email: { type: 'string' }, password: { type: 'string' } },
      },
      ChangePasswordInput: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        additionalProperties: false,
        properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 10 } },
      },
      UserEnvelope: {
        type: 'object',
        properties: {
          user: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } } },
        },
      },
      BusinessInput: {
        type: 'object',
        required: ['name', 'category'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 120 },
          category: { enum: ['restaurante', 'cafeteria', 'tienda', 'belleza', 'servicios', 'salud', 'otro'] },
          city: { type: ['string', 'null'], maxLength: 80 },
        },
      },
      BusinessPatch: { allOf: [ref('BusinessInput')], required: [], minProperties: 1 },
      Business: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string' },
          city: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Review: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          content: { type: 'string' },
          rating: { type: ['integer', 'null'] },
          sentiment: { enum: ['positive', 'neutral', 'negative', null] },
          sentimentScore: { type: ['number', 'null'] },
          topics: { type: 'array', items: { type: 'string' } },
        },
      },
      ImportSummary: {
        type: 'object',
        properties: {
          received: { type: 'integer' },
          imported: { type: 'integer' },
          duplicates: { type: 'integer' },
          rejected: { type: 'array', items: { type: 'object' } },
        },
      },
      AnalysisRun: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { enum: ['pending', 'running', 'completed', 'failed'] },
          provider: { type: 'string' },
          reviewCount: { type: 'integer' },
          attempts: { type: 'integer' },
          error: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;
