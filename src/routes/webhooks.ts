import { Router, Request, Response } from 'express';
import express from 'express';
import { handleInboundMessage, sendTestMessage } from '../services/whatsapp';
import {
  verifyWebhookSubscription,
  verifyMetaSignature,
  parseMetaInbound,
  metaConfigured,
} from '../services/meta';
import prisma from '../lib/prisma';

const router = Router();

// ─── Meta WhatsApp Cloud API webhook ──────────────────────────────────────────
// GET  /api/webhooks/meta  – subscription verification (hub.challenge handshake)
router.get('/meta', (req: Request, res: Response) => {
  const challenge = verifyWebhookSubscription(
    req.query['hub.mode'],
    req.query['hub.verify_token'],
    req.query['hub.challenge'],
  );
  if (challenge !== null) {
    console.log('[Meta] Webhook verification successful');
    res.status(200).send(challenge);
  } else {
    console.warn('[Meta] Webhook verification failed');
    res.sendStatus(403);
  }
});

// POST /api/webhooks/meta  – inbound messages (signed with X-Hub-Signature-256)
router.post('/meta', async (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!verifyMetaSignature(rawBody, signature)) {
    console.warn('[Meta] Rejected webhook: invalid or missing X-Hub-Signature-256');
    res.sendStatus(403);
    return;
  }

  // Ack immediately so Meta does not retry; process asynchronously.
  res.sendStatus(200);

  try {
    const inbound = parseMetaInbound(req.body);
    if (!inbound) return; // status callback or unsupported type
    console.log('[Meta] Inbound from:', inbound.from, '| Message:', inbound.text);
    await handleInboundMessage(`whatsapp:${inbound.from}`, inbound.text, inbound.messageId);
  } catch (err) {
    console.error('[Meta] Inbound processing error:', err);
  }
});

// GET /api/webhooks/whatsapp  – Twilio validation (challenge not needed for Twilio, but kept for Meta compatibility)
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] Verification successful');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ success: false, message: 'Verification failed' });
  }
});

// POST /api/webhooks/whatsapp  – Twilio inbound messages
router.post('/whatsapp', async (req: Request, res: Response) => {
  try {
    // Twilio sends form-encoded body
    const from: string = req.body.From || '';
    const body: string = req.body.Body || '';
    const messageSid: string = req.body.MessageSid || '';

    if (!from || !body) {
      res.status(200).send('<Response/>');
      return;
    }

    console.log('[Webhook] Inbound from:', from, '| Message:', body);

    await handleInboundMessage(from, body, messageSid);

    // Twilio expects a TwiML response (empty is fine)
    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response/>');
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response/>');
  }
});

// POST /api/webhooks/simulate  – Simulate inbound worker reply (for dev/testing)
// Body: { phone: "+601...", message: "DONE" | "ISSUE ..." | "HELP" }
router.post('/simulate', express.json(), async (req: Request, res: Response) => {
  try {
    const { phone, message } = req.body as { phone?: string; message?: string };
    if (!phone || !message) {
      res.status(400).json({ success: false, message: 'phone and message are required' });
      return;
    }
    const from = `whatsapp:${phone}`;
    await handleInboundMessage(from, message, `sim_${Date.now()}`, { simulateOutbound: true });
    res.json({ success: true, message: 'Simulation processed without sending real WhatsApp messages' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// POST /api/webhooks/test  – Diagnostic: send a real WhatsApp test to a phone or userId
// Body: { phone?: "+947...", userId?: "uuid", message?: "..." }
// Returns: { success, delivery: { status, sid?, errorCode?, errorMessage?, to } }
router.post('/test', express.json(), async (req: Request, res: Response) => {
  try {
    const { phone: rawPhone, userId, message } = req.body as {
      phone?: string;
      userId?: string;
      message?: string;
    };

    let phone = rawPhone;
    if (!phone && userId) {
      const u = await prisma.user.findUnique({ where: { id: userId } });
      if (!u) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      phone = u.phone;
    }
    if (!phone) {
      res.status(400).json({ success: false, message: 'Provide either "phone" or "userId".' });
      return;
    }

    const delivery = await sendTestMessage(phone, message);
    const httpStatus = delivery.status === 'failed' ? 200 : 200; // always 200; status is in body
    res.status(httpStatus).json({
      success: delivery.status === 'sent' || delivery.status === 'demo_sent',
      delivery,
      config: {
        from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
        hasSid: !!process.env.TWILIO_ACCOUNT_SID,
        hasToken: !!process.env.TWILIO_AUTH_TOKEN,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// GET /api/webhooks/config  – Quick health check of Twilio env config
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      provider: metaConfigured() ? 'meta' : (process.env.TWILIO_ACCOUNT_SID ? 'twilio' : 'demo'),
      twilio: {
        from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
        hasSid: !!process.env.TWILIO_ACCOUNT_SID,
        hasToken: !!process.env.TWILIO_AUTH_TOKEN,
      },
      meta: {
        configured: metaConfigured(),
        hasAccessToken: !!process.env.META_ACCESS_TOKEN,
        hasPhoneNumberId: !!process.env.META_PHONE_NUMBER_ID,
        hasAppSecret: !!process.env.META_APP_SECRET,
        verifyTokenSet: !!(process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN),
      },
    },
  });
});

export default router;
