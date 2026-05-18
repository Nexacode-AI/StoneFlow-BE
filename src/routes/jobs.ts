import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { startWorkflow, advanceWorkflow } from '../services/workflow';

const router = Router();

const StepSchema = z.object({
  stepNumber: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  assignedUserId: z.string().uuid().optional(),
  dueAt: z.string().optional(),
});

const CreateJobSchema = z.object({
  title: z.string().min(2),
  clientName: z.string().min(2),
  clientPhone: z.string().optional(),
  description: z.string().optional(),
  measurements: z.string().optional(),
  material: z.string().optional(),
  color: z.string().optional(),
  deadline: z.string(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  notes: z.string().optional(),
  steps: z.array(StepSchema).optional(),
});

function generateJobNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `JOB-${year}-${rand}`;
}

// GET /api/jobs
router.get('/', async (req: Request, res: Response) => {
  const { status, priority, search } = req.query as Record<string, string>;

  const jobs = await prisma.job.findMany({
    where: {
      ...(status && { status: status as never }),
      ...(priority && { priority: priority as never }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { clientName: { contains: search, mode: 'insensitive' } },
          { jobNumber: { contains: search, mode: 'insensitive' } },
        ],
      }),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      workflowSteps: {
        include: { assignedUser: { select: { id: true, name: true, role: true, phone: true } } },
        orderBy: { stepNumber: 'asc' },
      },
      _count: { select: { photos: true, messages: true } },
    },
  });

  res.json({ success: true, data: jobs });
});

// GET /api/jobs/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      workflowSteps: {
        include: {
          assignedUser: true,
          photos: { take: 5 },
          messages: { orderBy: { sentAt: 'desc' }, take: 5 },
        },
        orderBy: { stepNumber: 'asc' },
      },
      auditLogs: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
      photos: { orderBy: { uploadedAt: 'desc' }, take: 20 },
      _count: { select: { photos: true, messages: true } },
    },
  });

  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }
  res.json({ success: true, data: job });
});

// POST /api/jobs
router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.errors });
    return;
  }

  const { steps, ...jobData } = parsed.data;
  let jobNumber = generateJobNumber();

  // Ensure unique job number
  while (await prisma.job.findUnique({ where: { jobNumber } })) {
    jobNumber = generateJobNumber();
  }

  const job = await prisma.job.create({
    data: {
      ...jobData,
      jobNumber,
      deadline: new Date(jobData.deadline),
      totalSteps: steps?.length || 0,
      workflowSteps: steps
        ? {
            create: steps.map((s) => ({
              stepNumber: s.stepNumber,
              name: s.name,
              description: s.description,
              assignedUserId: s.assignedUserId,
              dueAt: s.dueAt ? new Date(s.dueAt) : undefined,
            })),
          }
        : undefined,
    },
    include: {
      workflowSteps: { include: { assignedUser: true }, orderBy: { stepNumber: 'asc' } },
    },
  });

  await prisma.auditLog.create({
    data: {
      jobId: job.id,
      eventType: 'JOB_CREATED',
      description: `Job #${job.jobNumber} created for ${job.clientName}`,
    },
  });

  const settings = await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });

  if (settings.autoStart && job.workflowSteps.length > 0) {
    await startWorkflow(job.id);
  }

  const responseJob = await prisma.job.findUnique({
    where: { id: job.id },
    include: {
      workflowSteps: { include: { assignedUser: true }, orderBy: { stepNumber: 'asc' } },
    },
  });

  res.status(201).json({ success: true, data: responseJob ?? job });
});

// PUT /api/jobs/:id
router.put('/:id', async (req: Request, res: Response) => {
  const parsed = CreateJobSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const { steps, ...jobData } = parsed.data;
  const job = await prisma.job.update({
    where: { id: String(req.params.id) },
    data: {
      ...jobData,
      ...(jobData.deadline && { deadline: new Date(jobData.deadline) }),
    },
  });
  res.json({ success: true, data: job });
});

// DELETE /api/jobs/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await prisma.job.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Job deleted' });
});

// POST /api/jobs/:id/start
router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    await startWorkflow(String(req.params.id));
    res.json({ success: true, message: 'Workflow started' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, message: `Failed to start workflow: ${msg}` });
  }
});

// POST /api/jobs/:id/steps/:stepId/complete
router.post('/:id/steps/:stepId/complete', async (req: Request, res: Response) => {
  try {
    await advanceWorkflow(String(req.params.id), String(req.params.stepId));
    res.json({ success: true, message: 'Step completed, next step notified' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, message: `Failed to advance workflow: ${msg}` });
  }
});

// PATCH /api/jobs/:id/steps/:stepId
router.patch('/:id/steps/:stepId', async (req: Request, res: Response) => {
  const step = await prisma.workflowStep.update({
    where: { id: String(req.params.stepId) },
    data: req.body,
    include: { assignedUser: true },
  });
  res.json({ success: true, data: step });
});

// POST /api/jobs/:id/steps  – add a step to existing job
router.post('/:id/steps', async (req: Request, res: Response) => {
  const parsed = StepSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const step = await prisma.workflowStep.create({
    data: { ...parsed.data, jobId: String(req.params.id) },
    include: { assignedUser: true },
  });
  await prisma.job.update({
    where: { id: String(req.params.id) },
    data: { totalSteps: { increment: 1 } },
  });
  res.status(201).json({ success: true, data: step });
});

export default router;
