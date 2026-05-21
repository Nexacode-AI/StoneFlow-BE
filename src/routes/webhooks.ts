import { Router, Request, Response } from 'express';
import express from 'express';
import { handleInboundMessage, sendTestMessage } from '../services/whatsapp';
import prisma from '../lib/prisma';

const router = Router();

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
      from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
      hasSid: !!process.env.TWILIO_ACCOUNT_SID,
      hasToken: !!process.env.TWILIO_AUTH_TOKEN,
      verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN,
    },
  });
});

export default router;
