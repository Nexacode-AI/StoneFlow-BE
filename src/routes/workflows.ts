import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';

const router = Router();

const TemplateSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  steps: z.array(
    z.object({
      stepNumber: z.number(),
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
});

// GET /api/workflow-templates
router.get('/', async (_req: Request, res: Response) => {
  const templates = await prisma.workflowTemplate.findMany({
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  res.json({ success: true, data: templates });
});

// POST /api/workflow-templates
router.post('/', async (req: Request, res: Response) => {
  const parsed = TemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const template = await prisma.workflowTemplate.create({ data: parsed.data });
  res.status(201).json({ success: true, data: template });
});

// GET /api/workflow-templates/:id
router.get('/:id', async (req: Request, res: Response) => {
  const template = await prisma.workflowTemplate.findUnique({ where: { id: String(req.params.id) } });
  if (!template) { res.status(404).json({ success: false, message: 'Template not found' }); return; }
  res.json({ success: true, data: template });
});

// DELETE /api/workflow-templates/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await prisma.workflowTemplate.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Template deleted' });
});

export default router;
