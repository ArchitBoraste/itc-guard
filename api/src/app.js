import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { apiRouter } from './routes/api.js';

// pingDb is injected so the app can be exercised without a live MySQL.
// mountApi is off by default so health-only tests need no database.
// auth is injected so a route test can run against its own org instead of the
// demo's — see apiRouter().
// extraRoutes mounts additional routers ahead of the 404, which is how the error
// responder below is tested against errors that cannot be provoked through a real
// endpoint on demand (a mysql2 parse error, an unlabelled throw). Never passed in
// production.
export function createApp({ pingDb, mountApi = true, auth, extraRoutes = null }) {
  const app = express();

  // Nothing gains from announcing the framework.
  app.disable('x-powered-by');

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.use(healthRouter({ pingDb }));
  if (mountApi) app.use('/api', apiRouter(auth ? { auth } : undefined));
  if (extraRoutes) app.use(extraRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // The error responder.
  //
  // Two kinds of error reach here and they must not be treated alike:
  //
  //   DELIBERATE  — a ServiceError, or one thrown with an explicit status and
  //                 code. Its message is copy written for the trader ("taxPeriod
  //                 must be YYYY-MM", "the demo is at capacity right now"), and
  //                 removing it would leave the UI with nothing to say.
  //
  //   UNEXPECTED  — anything else. A mysql2 error carries `.sql` and a `.message`
  //                 containing the failing statement, and its `.code` is
  //                 `ER_PARSE_ERROR` or similar. Forwarding that verbatim hands a
  //                 visitor the schema and the query text.
  //
  // In production the second kind is answered with a fixed sentence and nothing
  // else. The real error still goes to the container log in full, where it is
  // useful and not public. Outside production nothing is redacted, so a failing
  // test and a local run still show the actual cause immediately.
  app.use((err, req, res, next) => {
    // Multer rejects an oversized file before any handler runs, with a code but
    // no status.
    const isUploadTooLarge = err.code === 'LIMIT_FILE_SIZE';
    const status = isUploadTooLarge ? 413 : err.status ?? 500;

    if (status >= 500) console.error(err);

    // `expose` is set by ServiceError and by the few errors thrown with a
    // hand-written status; it is what separates the two kinds above. Anything
    // below 500 was a deliberate rejection of the request either way.
    const deliberate = isUploadTooLarge || err.expose === true || status < 500;
    const redact = process.env.NODE_ENV === 'production' && !deliberate;

    const code = isUploadTooLarge ? 'file_too_large' : err.code ?? 'internal_error';

    res.status(status).json({
      error: redact ? 'internal_error' : code,
      message: redact
        ? 'something went wrong on our side — this has been logged'
        : err.message
    });
  });

  return app;
}
