import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { withCache } from '../lib/cache';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const data = await withCache('dashboard', 30, async () => {
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

    const overdueJobs = await prisma.job.count({
      where: {
        deadline: { lt: now },
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
    });

    const upcomingJobs = await prisma.job.count({
      where: {
        status: 'PENDING',
        deadline: { gte: now },
      },
    });

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

    const allAlerts = [...alertSteps.map(s => ({ ...s, isSubTask: false })), ...subTaskAlerts]
      .sort((a, b) => new Date((b as { updatedAt: string | Date }).updatedAt).getTime() - new Date((a as { updatedAt: string | Date }).updatedAt).getTime())
      .slice(0, 50);

    const recentActivity = await prisma.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { job: true, user: true },
    });

    return {
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
    };
  });

  res.json({ success: true, data });
});

export default router;
