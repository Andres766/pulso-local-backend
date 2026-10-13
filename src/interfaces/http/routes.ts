import { Router } from 'express';
import multer from 'multer';
import type { AppDependencies } from '../../app.js';
import { HttpError } from './middlewares/errorHandler.js';
import { analysisLimiter, authLimiter, noStore, requireAuth } from './middlewares/security.js';

const MAX_CSV_BYTES = 1024 * 1024;
const CSV_MIME_TYPES = new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv']);

/** Subida en memoria (nunca se escribe al disco) con límite de tamaño y de tipo. */
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(csv|txt)$/i.test(file.originalname);
    if (okExt && CSV_MIME_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'INVALID_FILE_TYPE', 'Solo se aceptan archivos .csv'));
  },
});

export function createApiRouter(c: AppDependencies): Router {
  const router = Router();
  const auth = requireAuth(c.tokens);

  router.use(noStore);

  router.get('/health', async (_req, res) => {
    const db = await c.db.ping();
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db, ai: c.analyzer.providerName });
  });

  // Autenticación
  router.post('/auth/register', authLimiter, c.authController.register);
  router.post('/auth/login', authLimiter, c.authController.login);
  router.post('/auth/logout', c.authController.logout);
  router.get('/auth/me', auth, c.authController.me);

  // Negocios
  router.get('/businesses', auth, c.businessController.list);
  router.post('/businesses', auth, c.businessController.create);
  router.get('/businesses/:id', auth, c.businessController.show);
  router.delete('/businesses/:id', auth, c.businessController.remove);

  // Reseñas
  router.get('/businesses/:id/reviews', auth, c.reviewController.list);
  router.get('/businesses/:id/reviews/export', auth, c.reviewController.exportCsv);
  router.post('/businesses/:id/reviews/csv', auth, csvUpload.single('file'), c.reviewController.uploadCsv);
  router.post('/businesses/:id/reviews/text', auth, c.reviewController.paste);
  router.delete('/businesses/:id/reviews', auth, c.reviewController.clear);

  // Análisis de IA y dashboard
  router.get('/businesses/:id/dashboard', auth, c.analysisController.dashboard);
  router.post('/businesses/:id/analyses', auth, analysisLimiter, c.analysisController.start);
  router.get('/analyses/:id', auth, c.analysisController.status);

  return router;
}
