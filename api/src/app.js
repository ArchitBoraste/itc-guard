import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';

// pingDb is injected so the app can be exercised without a live MySQL.
export function createApp({ pingDb }) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.use(healthRouter({ pingDb }));

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.code ?? 'internal_error', message: err.message });
  });

  return app;
}
