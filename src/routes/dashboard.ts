import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const now = new Date();

  const [settings, totalJobs, activeJobs, completedJobs, totalUsers, pendingJobs] =
    await Promise.all([
      prisma.systemSettings.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton' },
        update: {},
      }),
      prisma.job.count(),
      prisma.job.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.job.count({ where: { status: 'COMPLETED' } }),
      prisma.user.count({ where: { isActive: true } }),
      prisma.job.count({ where: { status: 'PENDING' } }),
    ]);

  // Active IN_PROGRESS jobs (not just recently created)
  const recentJobs = await prisma.job.findMany({
    where: { status: { in: ['IN_PROGRESS', 'PENDING'] } },
    take: 8,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: {
      workflowSteps: {
        include: { assignedUser: { select: { id: true, name: true, role: true } } },
        orderBy: { stepNumber: 'asc' },
      },
    },
  });

  const jobsByStatus = await prisma.job.groupBy({
    by: ['status'],
    _count: { status: true },
  });

  // Overdue: deadline passed, not completed/cancelled
  const overdueJobs = await prisma.job.count({
    where: {
      deadline: { lt: now },
      status: { notIn: ['COMPLETED', 'CANCELLED'] },
    },
  });

  // Upcoming: PENDING jobs with a future deadline (not yet started, not overdue)
  const upcomingJobs = await prisma.job.count({
    where: {
      status: 'PENDING',
      deadline: { gte: now },
    },
  });

  // Alert steps: ISSUE or HELP_NEEDED
  // Gated on notifyAdmin — when the admin-alerts toggle is OFF in Settings,
  // no alerts appear in the dashboard UI and no WhatsApp is sent to admin.
  const alertSteps = settings.notifyAdmin
    ? await prisma.workflowStep.findMany({
        where: { status: { in: ['ISSUE', 'HELP_NEEDED'] } },
        include: {
          job: { select: { id: true, jobNumber: true, title: true } },
          assignedUser: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      })
    : [];

  // Sub-task alerts: sub-tasks with an issueText that are not yet completed
  const rawSubTaskAlerts = settings.notifyAdmin
    ? await prisma.workflowSubTask.findMany({
        where: {
          issueText: { not: null },
          status: { in: ['WAITING', 'NOTIFIED'] },
        },
        include: {
          step: { include: { job: { select: { id: true, jobNumber: true, title: true } } } },
          assignedUser: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      })
    : [];

  // Determine ISSUE vs HELP_NEEDED for each sub-task via audit log
  const subTaskStepIds = [...new Set(rawSubTaskAlerts.map((st) => st.stepId))];
  const subTaskAuditLogs = subTaskStepIds.length > 0
    ? await prisma.auditLog.findMany({
        where: {
          eventType: { in: ['SUBTASK_ISSUE', 'SUBTASK_HELP'] },
          stepId: { in: subTaskStepIds },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    : [];

  // Build map: subTaskId → 'ISSUE' | 'HELP_NEEDED' from most recent audit event
  const subTaskStatusMap = new Map<string, 'ISSUE' | 'HELP_NEEDED'>();
  for (const log of subTaskAuditLogs) {
    for (const st of rawSubTaskAlerts) {
      if (!subTaskStatusMap.has(st.id) && log.stepId === st.stepId &&
          log.description.toLowerCase().includes(st.title.toLowerCase())) {
        subTaskStatusMap.set(st.id, log.eventType === 'SUBTASK_ISSUE' ? 'ISSUE' : 'HELP_NEEDED');
        break;
      }
    }
  }

  const subTaskAlerts = rawSubTaskAlerts.map((st) => ({
    id: st.id,
    name: `${st.step.name} › ${st.title}`,
    status: (subTaskStatusMap.get(st.id) ?? 'ISSUE') as 'ISSUE' | 'HELP_NEEDED',
    issueText: st.issueText,
    updatedAt: st.updatedAt.toISOString(),
    job: st.step.job,
    assignedUser: st.assignedUser ?? undefined,
    isSubTask: true,
    stepId: st.stepId,
  }));

  // Merge step + sub-task alerts, sorted newest first
  const allAlerts = [...alertSteps.map(s => ({ ...s, isSubTask: false })), ...subTaskAlerts]
    .sort((a, b) => new Date((b as { updatedAt: string | Date }).updatedAt).getTime() - new Date((a as { updatedAt: string | Date }).updatedAt).getTime())
    .slice(0, 50);

  const recentActivity = await prisma.auditLog.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' },
    include: { job: true, user: true },
  });

  res.json({
    success: true,
    data: {
      stats: {
        totalJobs,
        activeJobs,
        completedJobs,
        pendingJobs,
        upcomingJobs,
        totalUsers,
        overdueJobs,
        alertCount: allAlerts.length,
      },
      jobsByStatus,
      recentJobs,
      recentActivity,
      alertSteps: allAlerts,
    },
  });
});

export default router;
