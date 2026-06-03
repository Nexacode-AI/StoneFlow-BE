import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { startWorkflow } from '../services/workflow';
import { withCache, invalidate, invalidatePattern } from '../lib/cache';

const router = Router();

function generateProjectNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `PROJ-${year}-${rand}`;
}

const CreateProjectSchema = z.object({
  name: z.string().min(2),
  clientName: z.string().min(2),
  clientPhone: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
  startDate: z.string().optional(),
  deadline: z.string().optional(),
  notes: z.string().optional(),
});

// Reusable include for unit jobs (full tracking detail)
const unitJobInclude = {
  workflowSteps: {
    select: {
      id: true,
      stepNumber: true,
      name: true,
      status: true,
      assignedUser: { select: { id: true, name: true, role: true } },
    },
    orderBy: { stepNumber: 'asc' as const },
  },
  _count: { select: { photos: true, messages: true } },
};

// ─── Status sync ──────────────────────────────────────────────────────────────
// Recalculates and persists the correct status for a project based on its jobs.
// Call after any job status change or project load to keep status accurate.
export async function syncProjectStatus(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true },
  });
  if (!project || project.status === 'CANCELLED') return;

  const [total, completed] = await Promise.all([
    prisma.job.count({ where: { projectId } }),
    prisma.job.count({ where: { projectId, status: 'COMPLETED' } }),
  ]);

  if (total === 0) return; // no units yet — leave status as-is

  const newStatus = total === completed ? 'COMPLETED' : 'ACTIVE';
  if (newStatus !== project.status) {
    await prisma.project.update({ where: { id: projectId }, data: { status: newStatus } });
  }
}

// ─── Projects CRUD ────────────────────────────────────────────────────────────

// GET /api/projects
router.get('/', async (req: Request, res: Response) => {
  const { status, search } = req.query as Record<string, string>;
  const cacheKey = `projects:list:${status || ''}|${search || ''}`;

  const data = await withCache(cacheKey, 30, async () => {
    const projects = await prisma.project.findMany({
      where: {
        ...(status && { status: status as never }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { clientName: { contains: search, mode: 'insensitive' } },
            { projectNumber: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { levels: true } },
        levels: { select: { _count: { select: { jobs: true } } } },
      },
    });

    return projects.map(p => ({
      ...p,
      levelCount: p._count.levels,
      totalUnits: p.levels.reduce((s: number, l: { _count: { jobs: number } }) => s + l._count.jobs, 0),
    }));
  });

  res.json({ success: true, data });
});

// GET /api/projects/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  // Check existence before cache so we can 404 early
  const exists = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return res.status(404).json({ success: false, error: 'Project not found' });

  // Recalculate status based on actual job completion state (may update DB)
  await syncProjectStatus(id);
  // Invalidate stale cache entry so the re-fetch below is stored fresh
  await invalidate(`projects:${id}`);

  const data = await withCache(`projects:${id}`, 30, async () => {
    return prisma.project.findUnique({
      where: { id },
      include: {
        levels: {
          orderBy: { order: 'asc' },
          include: { jobs: { orderBy: { createdAt: 'asc' }, include: unitJobInclude } },
        },
      },
    });
  });

  return res.json({ success: true, data });
});

// POST /api/projects
router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.flatten() });

  const { name, clientName, clientPhone, description, location, status, startDate, deadline, notes } = parsed.data;

  let projectNumber = generateProjectNumber();
  while (await prisma.project.findUnique({ where: { projectNumber } })) {
    projectNumber = generateProjectNumber();
  }

  const project = await prisma.project.create({
    data: {
      projectNumber, name, clientName, clientPhone, description, location,
      status: status ?? 'PLANNING',
      startDate: startDate ? new Date(startDate) : undefined,
      deadline: deadline ? new Date(deadline) : undefined,
      notes,
    },
  });

  await invalidatePattern('projects:list');

  return res.status(201).json({ success: true, data: project });
});

// PUT /api/projects/:id
router.put('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = CreateProjectSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.flatten() });

  const { startDate, deadline, ...rest } = parsed.data;
  const project = await prisma.project.update({
    where: { id },
    data: {
      ...rest,
      ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
      ...(deadline !== undefined && { deadline: deadline ? new Date(deadline) : null }),
    },
  });

  await invalidatePattern('projects:list');
  await invalidate(`projects:${id}`);

  return res.json({ success: true, data: project });
});

// DELETE /api/projects/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  await prisma.project.delete({ where: { id } });
  await invalidatePattern('projects:list');
  await invalidate(`projects:${id}`);
  return res.json({ success: true });
});

// ─── Level endpoints ──────────────────────────────────────────────────────────

// POST /api/projects/:id/levels
router.post('/:id/levels', async (req: Request, res: Response) => {
  const projectId = String(req.params.id);
  const { name } = req.body as { name?: string };

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Level name is required' });
  }

  const maxOrder = await prisma.projectLevel.aggregate({
    where: { projectId },
    _max: { order: true },
  });

  const level = await prisma.projectLevel.create({
    data: {
      projectId,
      name: name.trim(),
      order: (maxOrder._max.order ?? -1) + 1,
    },
    include: { jobs: { include: unitJobInclude } },
  });

  await invalidatePattern('projects:list');
  await invalidate(`projects:${projectId}`);

  return res.status(201).json({ success: true, data: level });
});

// PUT /api/projects/:id/levels/:levelId
router.put('/:id/levels/:levelId', async (req: Request, res: Response) => {
  const projectId = String(req.params.id);
  const { name, order } = req.body as { name?: string; order?: number };
  const level = await prisma.projectLevel.update({
    where: { id: String(req.params.levelId) },
    data: {
      ...(name && { name: String(name).trim() }),
      ...(order !== undefined && { order: Number(order) }),
    },
    include: { jobs: { include: unitJobInclude } },
  });
  await invalidate(`projects:${projectId}`);
  return res.json({ success: true, data: level });
});

// DELETE /api/projects/:id/levels/:levelId
router.delete('/:id/levels/:levelId', async (req: Request, res: Response) => {
  const projectId = String(req.params.id);
  await prisma.projectLevel.delete({ where: { id: String(req.params.levelId) } });
  await invalidatePattern('projects:list');
  await invalidate(`projects:${projectId}`);
  return res.json({ success: true });
});

// ─── Start project ────────────────────────────────────────────────────────────

// POST /api/projects/:id/start — starts pending unit jobs (all, or a selected subset via jobIds)
router.post('/:id/start', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { jobIds } = req.body as { jobIds?: string[] };

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      levels: {
        orderBy: { order: 'asc' },
        include: {
          jobs: {
            where: { status: 'PENDING' },
            include: { workflowSteps: { select: { id: true }, take: 1 } },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  });

  if (!project) return res.status(404).json({ success: false, error: 'Project not found' });

  // Only start jobs that have workflow steps; if jobIds provided, filter to selection
  const pendingJobs = project.levels.flatMap(l =>
    l.jobs.filter(j => j.workflowSteps.length > 0)
  ).filter(j => !jobIds || jobIds.includes(j.id));

  let started = 0;
  for (const job of pendingJobs) {
    try {
      await startWorkflow(job.id);
      started++;
    } catch { /* skip if already started or error */ }
  }

  // Mark project as ACTIVE
  await prisma.project.update({ where: { id }, data: { status: 'ACTIVE' } });

  await invalidatePattern('projects:list');
  await invalidate(`projects:${id}`);

  return res.json({ success: true, data: { started, total: pendingJobs.length } });
});

export default router;
