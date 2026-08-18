import { Router } from 'express';

export function healthRouter({ pingDb }) {
  const router = Router();

  router.get('/health', async (req, res) => {
    let db = false;
    try {
      db = await pingDb();
    } catch (err) {
      db = false;
    }
    res.status(db ? 200 : 503).json({ ok: db, db });
  });

  return router;
}
