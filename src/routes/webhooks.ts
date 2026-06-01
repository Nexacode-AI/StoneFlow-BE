import { Router, Request, Response } from 'express';
import { handleInboundMessage, sendTestMessage } from '../services/whatsapp';
import prisma from '../lib/prisma';

const router = Router();

// GET /api/webhooks/whatsapp — Meta webhook verification challenge
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] Meta verification successful');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ success: false, message: 'Verification failed' });
  }
});

// POST /api/webhooks/whatsapp — Meta inbound messages (JSON format)
router.post('/whatsapp', async (req: Request, res: Response) => {
  // Respond 200 immediately — Meta retries if it does not get a quick response
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const messages = change.value?.messages ?? [];
        for (const message of messages) {
          if (message.type !== 'text') continue;

          const from: string = message.from;
          const msgBody: string = message.text?.body ?? '';
          const messageId: string = message.id;

          if (!from || !msgBody) continue;

          console.log('[Webhook] Inbound from:', from, '| Message:', msgBody);
          await handleInboundMessage(from, msgBody, messageId);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error processing Meta message:', err);
  }
});

// POST /api/webhooks/simulate — Simulate inbound worker reply (dev/testing)
// Body: { phone: "+601...", message: "DONE" | "ISSUE ..." | "HELP" }
router.post('/simulate', async (req: Request, res: Response) => {
  try {
    const { phone, message } = req.body as { phone?: string; message?: string };
    if (!phone || !message) {
      res.status(400).json({ success: false, message: 'phone and message are required' });
      return;
    }
    await handleInboundMessage(phone, message, `sim-inbound`, { simulateOutbound: true });
    res.json({ success: true, message: 'Simulation processed without sending real WhatsApp messages' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// POST /api/webhooks/test — Diagnostic: send a real WhatsApp test message
// Body: { phone?: "+601...", userId?: "uuid", message?: "..." }
router.post('/test', async (req: Request, res: Response) => {
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
    res.status(200).json({
      success: delivery.status === 'sent' || delivery.status === 'demo_sent',
      delivery,
      config: {
        phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
        hasAccessToken: !!process.env.META_ACCESS_TOKEN,
        verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// GET /api/webhooks/config — Health check of Meta env config
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
      hasAccessToken: !!process.env.META_ACCESS_TOKEN,
      verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN,
    },
  });
});

export default router;
