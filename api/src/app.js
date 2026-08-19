import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { apiRouter } from './routes/api.js';

// pingDb is injected so the app can be exercised without a live MySQL.
// mountApi is off by default so health-only tests need no database.
export function createApp({ pingDb, mountApi = true }) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.use(healthRouter({ pingDb }));
  if (mountApi) app.use('/api', apiRouter());

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    // Multer rejects an oversized file before any handler runs.
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : err.code ?? 'internal_error';
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : status).json({
      error: code,
      message: err.message
    });
  });

  return app;
}
