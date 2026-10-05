import express, { Router } from 'express';
import { config } from '../config.js';
import {
  handleWhatsappWebhook,
  processLater,
  subscriptionChallenge,
  verifySignature
} from '../services/whatsappWebhook.js';

// Webhooks from outside services, mounted at /api/webhooks ahead of the JSON body
// parser and the session middleware (app.js): a signature covers the raw bytes,
// and a caller like Meta has no cookie and must never mint a visitor workspace.
// Anything under here that is not a known hook is a 404, never passed on.
//
// handle is injectable so a test can count what reaches processing.
export function webhookRouter({ handle = handleWhatsappWebhook } = {}) {
  const router = Router();

  router.get('/whatsapp', (req, res) => {
    const challenge = subscriptionChallenge(req.query);
    if (challenge === null) return res.status(403).json({ error: 'forbidden', message: 'verification refused' });
    res.type('text/plain').send(challenge);
  });

  router.post('/whatsapp', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const { appSecret } = config.whatsapp;
    if (!appSecret) {
      return res.status(503).json({ error: 'whatsapp_not_configured', message: 'WhatsApp is not set up on this server' });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.get('x-hub-signature-256'), appSecret)) {
      return res.status(401).json({ error: 'bad_signature', message: 'the signature does not match this body' });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'bad_request', message: 'the body is not JSON' });
    }
    // Answered first: Meta retries a webhook that is slow to answer.
    res.sendStatus(200);
    processLater(() => handle(payload));
  });

  router.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.originalUrl });
  });

  return router;
}
