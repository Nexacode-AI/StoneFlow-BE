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
  const alertSteps = settings.notifyAdmin
    ? await prisma.workflowStep.findMany({
        where: { status: { in: ['ISSUE', 'HELP_NEEDED'] } },
        include: {
          job: { select: { id: true, jobNumber: true, title: true } },
          assignedUser: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      })
    : [];

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
        alertCount: alertSteps.length,
      },
      jobsByStatus,
      recentJobs,
      recentActivity,
      alertSteps,
    },
  });
});

export default router;
