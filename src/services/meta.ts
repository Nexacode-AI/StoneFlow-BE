import crypto from 'crypto';

// ─── Meta WhatsApp Cloud API client ───────────────────────────────────────────
// Production-grade integration: webhook verification (GET hub.challenge),
// signed-payload verification (X-Hub-Signature-256), and Graph API sending.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

const accessToken = () => process.env.META_ACCESS_TOKEN || '';
const phoneNumberId = () => process.env.META_PHONE_NUMBER_ID || '';
const appSecret = () => process.env.META_APP_SECRET || '';

export function metaConfigured(): boolean {
  return !!(accessToken() && phoneNumberId());
}

// Meta expects a bare MSISDN — strip "whatsapp:", "+" and any separators.
function toMetaRecipient(to: string): string {
  return (to || '').replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
}

// Send a plain text message. Returns the WhatsApp message id (wamid).
export async function sendMetaText(to: string, body: string): Promise<string> {
  const recipient = toMetaRecipient(to);
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId()}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body, preview_url: false },
      }),
    },
  );

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Meta API ${res.status}: ${err?.error?.message || JSON.stringify(err)}`);
  }

  const data = (await res.json()) as { messages?: Array<{ id?: string }> };
  return data?.messages?.[0]?.id || '';
}

// ─── Webhook GET verification (subscribe handshake) ───────────────────────────
// Returns the challenge string to echo back, or null if the token doesn't match.
export function verifyWebhookSubscription(
  mode: unknown,
  token: unknown,
  challenge: unknown,
): string | null {
  const expected =
    process.env.META_WEBHOOK_VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    '';
  if (mode === 'subscribe' && token === expected && typeof challenge === 'string') {
    return challenge;
  }
  return null;
}

// ─── Webhook POST signature verification (X-Hub-Signature-256) ────────────────
// HMAC-SHA256 of the RAW request body keyed with the App Secret, timing-safe.
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
): boolean {
  const secret = appSecret();
  // No secret configured → cannot verify → reject (fail closed in production).
  if (!secret) return false;
  if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expectedHex = signatureHeader.slice('sha256='.length);
  const computedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const a = Buffer.from(computedHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Inbound payload parsing ──────────────────────────────────────────────────
export type MetaInbound = { from: string; text: string; messageId: string };

// Extracts a single inbound user message. Returns null for status callbacks
// (sent/delivered/read) and unsupported message types, which we simply ack.
export function parseMetaInbound(body: unknown): MetaInbound | null {
  try {
    const b = body as {
      entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }>;
    };
    const change = b?.entry?.[0]?.changes?.[0];
    if (change?.field !== 'messages') return null;

    const value = change.value as { messages?: Array<Record<string, unknown>> } | undefined;
    const msg = value?.messages?.[0] as
      | {
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: {
            button_reply?: { title?: string };
            list_reply?: { title?: string };
          };
        }
      | undefined;
    if (!msg || !msg.from) return null;

    let text = '';
    if (msg.type === 'text') {
      text = msg.text?.body || '';
    } else if (msg.type === 'button') {
      text = msg.button?.text || '';
    } else if (msg.type === 'interactive') {
      text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    } else {
      return null;
    }

    if (!text) return null;
    // Meta `from` is a bare MSISDN (e.g. "60123456789") — normalise to "+..."
    return { from: `+${msg.from.replace(/[^\d]/g, '')}`, text, messageId: msg.id || '' };
  } catch {
    return null;
  }
}
