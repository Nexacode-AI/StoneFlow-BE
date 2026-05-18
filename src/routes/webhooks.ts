import { Router, Request, Response } from 'express';
import { handleInboundMessage } from '../services/whatsapp';

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
router.post('/simulate', async (req: Request, res: Response) => {
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

export default router;
