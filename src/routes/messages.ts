import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';

const router = Router();

// GET /api/messages — list WhatsApp messages with job + user info
router.get('/', async (req: Request, res: Response) => {
  const { jobId, userId, direction, limit = '50' } = req.query;

  const where: Record<string, unknown> = {};
  if (jobId) where.jobId = String(jobId);
  if (userId) where.userId = String(userId);
  if (direction) where.direction = String(direction);

  const messages = await prisma.whatsAppMessage.findMany({
    where,
    include: {
      job: { select: { id: true, jobNumber: true, title: true } },
      user: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { sentAt: 'desc' },
    take: Math.min(Number(limit), 200),
  });

  res.json({ success: true, data: messages });
});

// GET /api/messages/job/:jobId — messages for a specific job
router.get('/job/:jobId', async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);

  const messages = await prisma.whatsAppMessage.findMany({
    where: { jobId },
    include: {
      user: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { sentAt: 'asc' },
  });

  res.json({ success: true, data: messages });
});

// POST /api/messages/reply-step — admin replies directly to a specific step's worker
// body: { stepId, adminId, message }
router.post('/reply-step', async (req: Request, res: Response) => {
  const { stepId, adminId, message } = req.body as { stepId: string; adminId: string; message: string };
  if (!stepId || !adminId || !message?.trim()) {
    res.status(400).json({ success: false, message: 'stepId, adminId and message required' });
    return;
  }
  try {
    const { sendAdminReplyToStep } = await import('../services/whatsapp');
    const result = await sendAdminReplyToStep(stepId, adminId, message.trim());
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// POST /api/messages/reply-subtask — admin replies to a sub-task worker
// body: { subTaskId, adminId, message }
router.post('/reply-subtask', async (req: Request, res: Response) => {
  const { subTaskId, adminId, message } = req.body as { subTaskId: string; adminId: string; message: string };
  if (!subTaskId || !adminId || !message?.trim()) {
    res.status(400).json({ success: false, message: 'subTaskId, adminId and message required' });
    return;
  }
  try {
    const { sendAdminReplyToSubTask } = await import('../services/whatsapp');
    const result = await sendAdminReplyToSubTask(subTaskId, adminId, message.trim());
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// POST /api/messages/resolve-step — admin resolves an issue on a specific step
// body: { stepId, adminId }
router.post('/resolve-step', async (req: Request, res: Response) => {
  const { stepId, adminId } = req.body as { stepId: string; adminId: string };
  if (!stepId || !adminId) {
    res.status(400).json({ success: false, message: 'stepId and adminId required' });
    return;
  }
  try {
    const { resolveStepById } = await import('../services/whatsapp');
    const result = await resolveStepById(stepId, adminId);
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// POST /api/messages/resolve-subtask — admin resolves an issue on a sub-task
// body: { subTaskId, adminId }
router.post('/resolve-subtask', async (req: Request, res: Response) => {
  const { subTaskId, adminId } = req.body as { subTaskId: string; adminId: string };
  if (!subTaskId || !adminId) {
    res.status(400).json({ success: false, message: 'subTaskId and adminId required' });
    return;
  }
  try {
    const { resolveSubTaskById } = await import('../services/whatsapp');
    const result = await resolveSubTaskById(subTaskId, adminId);
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message: msg });
  }
});

// POST /api/messages/admin-send — admin sends a message to a worker via UI
// body: { adminUserId, text }   e.g. text = "J001: please continue" or "RESOLVE J001"
router.post('/admin-send', async (req: Request, res: Response) => {
  const { adminUserId, text } = req.body as { adminUserId: string; text: string };
  if (!adminUserId || !text) {
    res.status(400).json({ success: false, message: 'adminUserId and text required' });
    return;
  }
  const admin = await prisma.user.findUnique({ where: { id: adminUserId } });
  if (!admin) {
    res.status(404).json({ success: false, message: 'Admin user not found' });
    return;
  }

  const { handleAdminMessageById } = await import('../services/whatsapp');
  await handleAdminMessageById(admin.id, text);
  res.json({ success: true });
});

export default router;
