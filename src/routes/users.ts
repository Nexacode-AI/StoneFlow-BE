import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';

const router = Router();

const CreateUserSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email().optional(),
  role: z.enum([
    'ADMIN', 'MANAGER', 'CUTTER', 'POLISHER', 'EDGE_FINISHER',
    'PACKER', 'LOADER', 'INSTALLER', 'QC_INSPECTOR', 'DRIVER', 'WORKER',
  ]),
  language: z.enum(['ENGLISH', 'BANGLA', 'MANDARIN', 'BAHASA_MALAY', 'TAMIL']).optional(),
});

// GET /api/users
router.get('/', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { assignedSteps: true } },
    },
  });
  res.json({ success: true, data: users });
});

// GET /api/users/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      assignedSteps: {
        include: { job: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      _count: { select: { assignedSteps: true } },
    },
  });
  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  res.json({ success: true, data: user });
});

// POST /api/users
router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.errors });
    return;
  }
  const user = await prisma.user.create({ data: parsed.data });
  res.status(201).json({ success: true, data: user });
});

// PUT /api/users/:id
router.put('/:id', async (req: Request, res: Response) => {
  const parsed = CreateUserSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.errors });
    return;
  }
  const user = await prisma.user.update({
    where: { id: String(req.params.id) },
    data: parsed.data,
  });
  res.json({ success: true, data: user });
});

// DELETE /api/users/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await prisma.user.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'User deleted' });
});

// PATCH /api/users/:id/toggle
router.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: !user.isActive },
  });
  res.json({ success: true, data: updated });
});

export default router;
