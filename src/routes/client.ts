import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'stone-secret-change-me';

// ─── Auth guard helper ─────────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  try {
    jwt.verify(auth.slice(7), JWT_SECRET);
    return true;
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
    return false;
  }
}

// ─── GET /api/client/track/:token ─────────────────────────────────────────────
// Public endpoint — no authentication required.
// Returns sanitized job data (no financial/internal-only fields) for client view.
router.get('/track/:token', async (req: Request, res: Response) => {
  const { token } = req.params;
  const safeToken = Array.isArray(token) ? token[0] : token;

  if (!safeToken || safeToken.length < 10) {
    res.status(400).json({ success: false, message: 'Invalid tracking token.' });
    return;
  }

  const job = await prisma.job.findUnique({
    where: { clientToken: safeToken },
    select: {
      id: true,
      jobNumber: true,
      title: true,
      clientName: true,
      material: true,
      color: true,
      measurements: true,
      deadline: true,
      status: true,
      priority: true,
      totalSteps: true,
      completedSteps: true,
      description: true,
      createdAt: true,
      completedAt: true,
      workflowSteps: {
        select: {
          id: true,
          stepNumber: true,
          name: true,
          description: true,
          status: true,
          startedAt: true,
          completedAt: true,
          dueAt: true,
        },
        orderBy: { stepNumber: 'asc' },
      },
    },
  });

  if (!job) {
    res.status(404).json({ success: false, message: 'Tracking link not found or has been revoked.' });
    return;
  }

  res.json({ success: true, data: job });
});

// ─── POST /api/client/generate/:jobId ─────────────────────────────────────────
// Admin-only: generate (or regenerate) a unique tracking token for a job.
router.post('/generate/:jobId', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const jobId = String(req.params.jobId);
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, jobNumber: true },
  });

  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found.' });
    return;
  }

  // Generate a cryptographically random token (48 hex chars = 192 bits)
  const token = crypto.randomBytes(24).toString('hex');

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { clientToken: token },
    select: { clientToken: true },
  });

  res.json({ success: true, token: updated.clientToken });
});

// ─── DELETE /api/client/revoke/:jobId ─────────────────────────────────────────
// Admin-only: revoke (delete) the client tracking token for a job.
router.delete('/revoke/:jobId', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const jobId = String(req.params.jobId);

  await prisma.job.update({
    where: { id: jobId },
    data: { clientToken: null },
  });

  res.json({ success: true, message: 'Tracking link revoked.' });
});

export default router;
