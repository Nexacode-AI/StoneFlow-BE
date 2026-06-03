import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { withCache } from '../lib/cache';

const router = Router();

// GET /api/analytics
router.get('/', async (_req: Request, res: Response) => {
  const data = await withCache('analytics', 300, async () => {
    // 1. Jobs by status
    const [pending, inProgress, completed] = await Promise.all([
      prisma.job.count({ where: { status: 'PENDING' } }),
      prisma.job.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.job.count({ where: { status: 'COMPLETED' } }),
    ]);

    const statusDistribution = [
      { name: 'Pending',     value: pending },
      { name: 'In Progress', value: inProgress },
      { name: 'Completed',   value: completed },
    ];

    // 2. Weekly job activity – last 5 weeks
    const now = new Date();
    const weeklyData: { week: string; created: number; completed: number }[] = [];
    for (let w = 4; w >= 0; w--) {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay() + 1 - w * 7);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);
      const [created, comp] = await Promise.all([
        prisma.job.count({ where: { createdAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.job.count({ where: { status: 'COMPLETED', updatedAt: { gte: weekStart, lt: weekEnd } } }),
      ]);
      const label = weekStart.toLocaleDateString('en-MY', { month: 'short', day: 'numeric' });
      weeklyData.push({ week: label, created, completed: comp });
    }

    // 3. Worker productivity
    const workers = await prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, role: true,
        _count: { select: { assignedSteps: { where: { status: 'COMPLETED' } } } },
      },
      orderBy: { name: 'asc' },
    });
    const workerProductivity = workers
      .map(u => ({ id: u.id, name: u.name, role: u.role, completed: u._count.assignedSteps }))
      .sort((a, b) => b.completed - a.completed);

    // 4. Priority distribution
    const [priLow, priNormal, priHigh, priUrgent] = await Promise.all([
      prisma.job.count({ where: { priority: 'LOW' } }),
      prisma.job.count({ where: { priority: 'NORMAL' } }),
      prisma.job.count({ where: { priority: 'HIGH' } }),
      prisma.job.count({ where: { priority: 'URGENT' } }),
    ]);
    const priorityDistribution = [
      { name: 'Low',    value: priLow,    color: '#22c55e' },
      { name: 'Normal', value: priNormal, color: '#3b82f6' },
      { name: 'High',   value: priHigh,   color: '#f59e0b' },
      { name: 'Urgent', value: priUrgent, color: '#ef4444' },
    ];

    // 5. Alert type distribution
    const [issueCount, helpCount] = await Promise.all([
      prisma.workflowStep.count({ where: { status: 'ISSUE' } }),
      prisma.workflowStep.count({ where: { status: 'HELP_NEEDED' } }),
    ]);
    const alertTypeDistribution = [
      { name: 'Issues',       value: issueCount, color: '#ef4444' },
      { name: 'Help Requests', value: helpCount, color: '#f59e0b' },
    ];

    // 6. Average job completion time (days)
    const completedJobs = await prisma.job.findMany({
      where: { status: 'COMPLETED' },
      select: { createdAt: true, updatedAt: true },
    });
    let avgCompletionDays = -1; // -1 = no completed jobs
    if (completedJobs.length > 0) {
      const totalMs = completedJobs.reduce((sum, j) => sum + (j.updatedAt.getTime() - j.createdAt.getTime()), 0);
      avgCompletionDays = (totalMs / completedJobs.length) / (1000 * 60 * 60 * 24); // raw float days
    }

    // 7. Daily activity – last 7 days
    const dailyActivity: { day: string; completed: number; alerts: number }[] = [];
    for (let d = 6; d >= 0; d--) {
      const dayStart = new Date(now);
      dayStart.setDate(now.getDate() - d);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayStart.getDate() + 1);
      const [comp, alerts] = await Promise.all([
        prisma.workflowStep.count({ where: { status: 'COMPLETED', updatedAt: { gte: dayStart, lt: dayEnd } } }),
        prisma.workflowStep.count({ where: { status: { in: ['ISSUE', 'HELP_NEEDED'] }, updatedAt: { gte: dayStart, lt: dayEnd } } }),
      ]);
      const label = dayStart.toLocaleDateString('en-MY', { weekday: 'short' });
      dailyActivity.push({ day: label, completed: comp, alerts });
    }

    return {
      statusDistribution,
      weeklyActivity: weeklyData,
      workerProductivity,
      priorityDistribution,
      alertTypeDistribution,
      avgCompletionDays,
      dailyActivity,
    };
  });

  res.json({ success: true, data });
});

export default router;
