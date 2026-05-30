import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { startWorkflow, advanceWorkflow } from '../services/workflow';
import { broadcastEvent } from '../lib/websocket';
import { sendRaisedIssueAlert, sendSubTaskTimerAlert } from '../services/whatsapp';
import { advanceSubTask } from '../services/workflow';

const router = Router();

const SubTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignedUserId: z.string().uuid().optional().or(z.literal('')).transform(v => v || undefined),
  dueAt: z.string().optional(),
  isCompleted: z.boolean().optional(),
  order: z.number().int().optional(),
});

const StepSchema = z.object({
  stepNumber: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  assignedUserId: z.string().uuid().optional(),
  dueAt: z.string().optional(),
  subTasks: z.array(SubTaskSchema).optional(),
});

const CreateJobSchema = z.object({
  title: z.string().min(2),
  clientName: z.string().min(2),
  clientPhone: z.string().optional(),
  description: z.string().optional(),
  measurements: z.string().optional(),
  material: z.string().optional(),
  color: z.string().optional(),
  startDate: z.string().optional(),
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
        include: {
          assignedUser: { select: { id: true, name: true, role: true, phone: true } },
          subTasks: {
            include: { assignedUser: { select: { id: true, name: true, role: true } } },
            orderBy: { order: 'asc' },
          },
        },
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
          subTasks: {
            include: { assignedUser: { select: { id: true, name: true, role: true } } },
            orderBy: { order: 'asc' },
          },
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
      startDate: jobData.startDate ? new Date(jobData.startDate) : undefined,
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
              subTasks: s.subTasks?.length
                ? {
                    create: s.subTasks.map((st, i) => ({
                      title: st.title,
                      description: st.description,
                      assignedUserId: st.assignedUserId || undefined,
                      dueAt: st.dueAt ? new Date(st.dueAt) : undefined,
                      order: st.order ?? i,
                    })),
                  }
                : undefined,
            })),
          }
        : undefined,
    },
    include: {
      workflowSteps: {
        include: { assignedUser: true, subTasks: { include: { assignedUser: { select: { id: true, name: true, role: true } } }, orderBy: { order: 'asc' } } },
        orderBy: { stepNumber: 'asc' },
      },
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
      workflowSteps: {
        include: { assignedUser: true, subTasks: { include: { assignedUser: { select: { id: true, name: true, role: true } } }, orderBy: { order: 'asc' } } },
        orderBy: { stepNumber: 'asc' },
      },
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

// PATCH /api/jobs/:id/status — update job status only
const StatusSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED']),
});

router.patch('/:id/status', async (req: Request, res: Response) => {
  const parsed = StatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const job = await prisma.job.update({
    where: { id: String(req.params.id) },
    data: {
      status: parsed.data.status,
      ...(parsed.data.status === 'COMPLETED' && { completedAt: new Date() }),
    },
  });
  res.json({ success: true, data: job });
});

// POST /api/jobs/:id/start
router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const result = await startWorkflow(String(req.params.id));
    const notification = result.notification;
    if (notification && notification.status === 'failed') {
      res.status(200).json({
        success: true,
        message: 'Workflow started, but the first WhatsApp notification failed.',
        notification,
      });
      return;
    }
    res.json({
      success: true,
      message: 'Workflow started',
      notification,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, message: `Failed to start workflow: ${msg}` });
  }
});

// POST /api/jobs/:id/steps/:stepId/complete
router.post('/:id/steps/:stepId/complete', async (req: Request, res: Response) => {
  try {
    const notification = await advanceWorkflow(String(req.params.id), String(req.params.stepId));
    res.json({
      success: true,
      message: 'Step completed, next step notified',
      notification,
    });
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
  const { subTasks, ...stepData } = parsed.data;
  const step = await prisma.workflowStep.create({
    data: {
      ...stepData,
      jobId: String(req.params.id),
      subTasks: subTasks?.length
        ? { create: subTasks.map((st, i) => ({ title: st.title, description: st.description, assignedUserId: st.assignedUserId || undefined, dueAt: st.dueAt ? new Date(st.dueAt) : undefined, order: st.order ?? i })) }
        : undefined,
    },
    include: { assignedUser: true, subTasks: { include: { assignedUser: { select: { id: true, name: true, role: true } } }, orderBy: { order: 'asc' } } },
  });
  await prisma.job.update({
    where: { id: String(req.params.id) },
    data: { totalSteps: { increment: 1 } },
  });
  res.status(201).json({ success: true, data: step });
});

// POST /api/jobs/:id/steps/:stepId/timer/start  – start countdown for a step
router.post('/:id/steps/:stepId/timer/start', async (req: Request, res: Response) => {
  const stepId = String(req.params.stepId);
  const schema = z.object({ durationMinutes: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const step = await prisma.workflowStep.update({
    where: { id: stepId },
    data: {
      durationMinutes: parsed.data.durationMinutes,
      timerStartedAt: new Date(),
      timerAlertSentAt: null,  // reset so a new alert can fire when this timer expires
    },
    include: { assignedUser: true, job: { select: { jobNumber: true, title: true } } },
  });
  res.json({ success: true, data: step });
});

// POST /api/jobs/:id/steps/:stepId/timer/reset  – clear timer
router.post('/:id/steps/:stepId/timer/reset', async (req: Request, res: Response) => {
  const stepId = String(req.params.stepId);
  const step = await prisma.workflowStep.update({
    where: { id: stepId },
    data: { durationMinutes: null, timerStartedAt: null, timerAlertSentAt: null },
    include: { assignedUser: true },
  });
  res.json({ success: true, data: step });
});

// POST /api/jobs/:id/steps/:stepId/raise  – admin raises ISSUE or HELP from dashboard
const RaiseSchema = z.object({
  type: z.enum(['ISSUE', 'HELP']),
  details: z.string().optional(),
  adminId: z.string().uuid().optional(),
});

router.post('/:id/steps/:stepId/raise', async (req: Request, res: Response) => {
  const parsed = RaiseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }

  const { type, details, adminId } = parsed.data;
  const stepId = String(req.params.stepId);
  const jobId = String(req.params.id);
  const status = type === 'ISSUE' ? 'ISSUE' : 'HELP_NEEDED';
  const issueText = details?.trim() || (type === 'ISSUE' ? 'Issue raised from dashboard' : 'Help requested from dashboard');

  const step = await prisma.workflowStep.update({
    where: { id: stepId },
    data: { status, issueText },
    include: { job: true, assignedUser: true },
  });

  await prisma.auditLog.create({
    data: {
      jobId,
      stepId,
      userId: adminId ?? null,
      eventType: type === 'ISSUE' ? 'STEP_ISSUE' : 'STEP_HELP',
      description: `${type === 'ISSUE' ? 'Issue' : 'Help request'} raised from dashboard on "${step.name}": ${issueText}`,
    },
  });

  broadcastEvent(type === 'ISSUE' ? 'step_issue' : 'step_help', { jobId, stepId, details: issueText });

  // Send the same WhatsApp admin alert that fires when a worker reports via WhatsApp.
  // Uses the notifyAdmin setting — if notifications are disabled in Settings, no WhatsApp is sent.
  const raisedBy = step.assignedUser
    ? { name: step.assignedUser.name, phone: step.assignedUser.phone }
    : null;
  await sendRaisedIssueAlert(step.job, { id: stepId, name: step.name }, raisedBy, type, issueText);

  res.json({ success: true, data: step });
});

// ─── Sub-task routes ─────────────────────────────────────────────────────────

// POST /api/jobs/:id/steps/:stepId/subtasks  – add a sub-task
router.post('/:id/steps/:stepId/subtasks', async (req: Request, res: Response) => {
  const parsed = SubTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const stepId = String(req.params.stepId);
  // get current max order
  const max = await prisma.workflowSubTask.aggregate({ where: { stepId }, _max: { order: true } });
  const order = parsed.data.order ?? ((max._max.order ?? -1) + 1);
  const subTask = await prisma.workflowSubTask.create({
    data: { ...parsed.data, stepId, order },
  });
  res.status(201).json({ success: true, data: subTask });
});

// PATCH /api/jobs/:id/steps/:stepId/subtasks/:subTaskId  – update a sub-task
router.patch('/:id/steps/:stepId/subtasks/:subTaskId', async (req: Request, res: Response) => {
  const parsed = SubTaskSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const subTask = await prisma.workflowSubTask.update({
    where: { id: String(req.params.subTaskId) },
    data: parsed.data,
  });
  res.json({ success: true, data: subTask });
});

// DELETE /api/jobs/:id/steps/:stepId/subtasks/:subTaskId  – delete a sub-task
router.delete('/:id/steps/:stepId/subtasks/:subTaskId', async (req: Request, res: Response) => {
  await prisma.workflowSubTask.delete({ where: { id: String(req.params.subTaskId) } });
  res.json({ success: true, message: 'Sub-task deleted' });
});

// ─── Sub-task action routes ──────────────────────────────────────────────────

const subTaskInclude = {
  include: {
    assignedUser: { select: { id: true, name: true, role: true, phone: true, language: true } },
    step: { include: { job: true } },
  },
};

// POST /api/jobs/:id/steps/:stepId/subtasks/:subTaskId/timer/start
router.post('/:id/steps/:stepId/subtasks/:subTaskId/timer/start', async (req: Request, res: Response) => {
  const schema = z.object({ durationMinutes: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, errors: parsed.error.errors }); return; }
  const subTask = await prisma.workflowSubTask.update({
    where: { id: String(req.params.subTaskId) },
    data: {
      durationMinutes: parsed.data.durationMinutes,
      timerStartedAt: new Date(),
      timerAlertSentAt: null,
    },
    ...subTaskInclude,
  });
  res.json({ success: true, data: subTask });
});

// POST /api/jobs/:id/steps/:stepId/subtasks/:subTaskId/timer/reset
router.post('/:id/steps/:stepId/subtasks/:subTaskId/timer/reset', async (req: Request, res: Response) => {
  const subTask = await prisma.workflowSubTask.update({
    where: { id: String(req.params.subTaskId) },
    data: { durationMinutes: null, timerStartedAt: null, timerAlertSentAt: null },
    ...subTaskInclude,
  });
  res.json({ success: true, data: subTask });
});

// POST /api/jobs/:id/steps/:stepId/subtasks/:subTaskId/raise  – raise issue on sub-task
router.post('/:id/steps/:stepId/subtasks/:subTaskId/raise', async (req: Request, res: Response) => {
  const parsed = RaiseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, errors: parsed.error.errors }); return; }
  const { type, details, adminId } = parsed.data;
  const subTaskId = String(req.params.subTaskId);
  const jobId = String(req.params.id);
  const stepId = String(req.params.stepId);
  const issueText = details?.trim() || (type === 'ISSUE' ? 'Issue raised from dashboard' : 'Help requested from dashboard');

  const subTask = await prisma.workflowSubTask.update({
    where: { id: subTaskId },
    data: { issueText },
    include: {
      assignedUser: { select: { id: true, name: true, phone: true, language: true, role: true } },
      step: { include: { job: true } },
    },
  });

  await prisma.auditLog.create({
    data: {
      jobId,
      stepId,
      userId: adminId ?? null,
      eventType: type === 'ISSUE' ? 'SUBTASK_ISSUE' : 'SUBTASK_HELP',
      description: `${type === 'ISSUE' ? 'Issue' : 'Help'} raised on sub-task "${subTask.title}": ${issueText}`,
    },
  });

  broadcastEvent(type === 'ISSUE' ? 'subtask_issue' : 'subtask_help', { jobId, stepId, subTaskId, details: issueText });

  const raisedBy = subTask.assignedUser
    ? { name: subTask.assignedUser.name, phone: subTask.assignedUser.phone }
    : null;
  await sendRaisedIssueAlert(subTask.step.job, { id: stepId, name: `${subTask.step.name} › ${subTask.title}` }, raisedBy, type, issueText);

  res.json({ success: true, data: subTask });
});

// POST /api/jobs/:id/steps/:stepId/subtasks/:subTaskId/complete  – admin marks sub-task done
router.post('/:id/steps/:stepId/subtasks/:subTaskId/complete', async (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  const subTaskId = String(req.params.subTaskId);
  await advanceSubTask(jobId, subTaskId);
  res.json({ success: true });
});

// GET /api/jobs/timers/active  – list all steps + sub-tasks with active timers
router.get('/timers/active', async (_req: Request, res: Response) => {
  const [steps, subTasks] = await Promise.all([
    prisma.workflowStep.findMany({
      where: {
        timerStartedAt: { not: null },
        durationMinutes: { not: null },
        status: { in: ['IN_PROGRESS', 'NOTIFIED', 'WAITING'] },
      },
      include: {
        assignedUser: { select: { id: true, name: true, phone: true, role: true } },
        job: { select: { id: true, jobNumber: true, title: true, clientName: true } },
      },
      orderBy: { timerStartedAt: 'asc' },
    }),
    prisma.workflowSubTask.findMany({
      where: {
        timerStartedAt: { not: null },
        durationMinutes: { not: null },
        status: { in: ['WAITING', 'NOTIFIED'] },
      },
      include: {
        assignedUser: { select: { id: true, name: true, phone: true, role: true } },
        step: {
          select: {
            id: true,
            stepNumber: true,
            name: true,
            job: { select: { id: true, jobNumber: true, title: true, clientName: true } },
          },
        },
      },
      orderBy: { timerStartedAt: 'asc' },
    }),
  ]);

  // Normalize sub-tasks to same shape as steps so frontend can render them uniformly
  const normalizedSubTasks = subTasks.map(st => ({
    id: st.id,
    name: st.title,
    stepNumber: null as number | null,
    stepId: st.stepId,
    status: st.status,
    timerStartedAt: st.timerStartedAt,
    durationMinutes: st.durationMinutes,
    assignedUser: st.assignedUser,
    job: st.step.job,
    parentStep: { id: st.step.id, stepNumber: st.step.stepNumber, name: st.step.name },
    isSubTask: true as const,
  }));

  const all = [
    ...steps.map(s => ({ ...s, isSubTask: false as const, parentStep: null })),
    ...normalizedSubTasks,
  ].sort((a, b) => new Date(a.timerStartedAt!).getTime() - new Date(b.timerStartedAt!).getTime());

  res.json({ success: true, data: all });
});

export default router;
