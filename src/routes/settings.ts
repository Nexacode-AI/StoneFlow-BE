import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { withCache, invalidate } from '../lib/cache';

const router = Router();

// GET /api/settings — return current settings (create singleton row if missing)
router.get('/', async (_req: Request, res: Response) => {
  const data = await withCache('settings', 300, async () => {
    return prisma.systemSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
  });
  res.json({ success: true, data });
});

// PATCH /api/settings — update settings
router.patch('/', async (req: Request, res: Response) => {
  const { companyName, timezone, notifyAdmin, autoStart, autoStartOnDate } = req.body;
  const settings = await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      ...(companyName      !== undefined && { companyName }),
      ...(timezone         !== undefined && { timezone }),
      ...(notifyAdmin      !== undefined && { notifyAdmin }),
      ...(autoStart        !== undefined && { autoStart }),
      ...(autoStartOnDate  !== undefined && { autoStartOnDate }),
    },
    update: {
      ...(companyName      !== undefined && { companyName }),
      ...(timezone         !== undefined && { timezone }),
      ...(notifyAdmin      !== undefined && { notifyAdmin }),
      ...(autoStart        !== undefined && { autoStart }),
      ...(autoStartOnDate  !== undefined && { autoStartOnDate }),
    },
  });
  await invalidate('settings');
  res.json({ success: true, data: settings });
});

export default router;
