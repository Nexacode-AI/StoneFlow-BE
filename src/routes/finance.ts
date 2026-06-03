import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { withCache, invalidate, invalidatePattern } from '../lib/cache';

const router = Router();

// ─── Company Expenses ─────────────────────────────────────────────────────────

// GET /api/finance/expenses  → all job expenses grouped by job
router.get('/expenses', async (_req: Request, res: Response) => {
  const data = await withCache('finance:expenses', 60, async () => {
    return prisma.job.findMany({
      select: {
        id: true,
        jobNumber: true,
        title: true,
        clientName: true,
        status: true,
        createdAt: true,
        expenses: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  });
  res.json({ success: true, data });
});

// POST /api/finance/expenses  → add expense to a job
router.post('/expenses', async (req: Request, res: Response) => {
  const Schema = z.object({
    jobId:    z.string().uuid(),
    partName: z.string().min(1),
    partType: z.string().default('ORI'),
    quantity: z.number().int().positive().default(1),
    amount:   z.number().nonnegative().optional(),
    pdfStatus: z.enum(['PENDING', 'EXTRACTED', 'EDITED']).default('PENDING'),
    notes:    z.string().optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const expense = await prisma.jobExpense.create({ data: parsed.data });
  await invalidatePattern('finance:');
  res.json({ success: true, data: expense });
});

// PATCH /api/finance/expenses/:id  → update amount / pdfStatus
router.patch('/expenses/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const Schema = z.object({
    amount:    z.number().nonnegative().optional(),
    pdfStatus: z.enum(['PENDING', 'EXTRACTED', 'EDITED']).optional(),
    partName:  z.string().optional(),
    partType:  z.string().optional(),
    quantity:  z.number().int().positive().optional(),
    notes:     z.string().optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  try {
    const expense = await prisma.jobExpense.update({ where: { id }, data: parsed.data });
    await invalidatePattern('finance:');
    res.json({ success: true, data: expense });
  } catch {
    res.status(404).json({ success: false, message: 'Expense not found' });
  }
});

// DELETE /api/finance/expenses/:id
router.delete('/expenses/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    await prisma.jobExpense.delete({ where: { id } });
    await invalidatePattern('finance:');
    res.json({ success: true });
  } catch {
    res.status(404).json({ success: false, message: 'Expense not found' });
  }
});

// ─── Revenue ──────────────────────────────────────────────────────────────────

// POST /api/finance/revenue  → set/update job revenue (upsert)
router.post('/revenue', async (req: Request, res: Response) => {
  const Schema = z.object({
    jobId:  z.string().uuid(),
    amount: z.number().nonnegative(),
    notes:  z.string().optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const revenue = await prisma.jobRevenue.upsert({
    where:  { jobId: parsed.data.jobId },
    update: { amount: parsed.data.amount, notes: parsed.data.notes },
    create: parsed.data,
  });
  await invalidatePattern('finance:');
  res.json({ success: true, data: revenue });
});

// ─── Personal Expenses ────────────────────────────────────────────────────────

// GET /api/finance/personal
router.get('/personal', async (_req: Request, res: Response) => {
  const data = await withCache('finance:personal', 60, async () => {
    return prisma.personalExpense.findMany({ orderBy: { date: 'desc' } });
  });
  res.json({ success: true, data });
});

// POST /api/finance/personal
router.post('/personal', async (req: Request, res: Response) => {
  const Schema = z.object({
    description: z.string().min(1),
    amount:      z.number().nonnegative(),
    category:    z.string().default('General'),
    date:        z.string().optional(),
    notes:       z.string().optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  const expense = await prisma.personalExpense.create({
    data: {
      ...parsed.data,
      date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
    },
  });
  await invalidatePattern('finance:');
  res.json({ success: true, data: expense });
});

// PATCH /api/finance/personal/:id
router.patch('/personal/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const Schema = z.object({
    description: z.string().optional(),
    amount:      z.number().nonnegative().optional(),
    category:    z.string().optional(),
    date:        z.string().optional(),
    notes:       z.string().optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.errors });
    return;
  }
  try {
    const updateData: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.date) updateData.date = new Date(parsed.data.date);
    const expense = await prisma.personalExpense.update({ where: { id }, data: updateData });
    await invalidatePattern('finance:');
    res.json({ success: true, data: expense });
  } catch {
    res.status(404).json({ success: false, message: 'Expense not found' });
  }
});

// DELETE /api/finance/personal/:id
router.delete('/personal/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    await prisma.personalExpense.delete({ where: { id } });
    await invalidatePattern('finance:');
    res.json({ success: true });
  } catch {
    res.status(404).json({ success: false, message: 'Expense not found' });
  }
});

// ─── Profit Summary ───────────────────────────────────────────────────────────

// GET /api/finance/profit  → per-job profit summary
router.get('/profit', async (_req: Request, res: Response) => {
  const data = await withCache('finance:profit', 60, async () => {
    const jobs = await prisma.job.findMany({
      select: {
        id: true,
        jobNumber: true,
        title: true,
        clientName: true,
        status: true,
        createdAt: true,
        expenses: { select: { id: true, amount: true, pdfStatus: true } },
        revenue:  { select: { amount: true, notes: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const summary = jobs.map(job => {
      // Only count expenses where an amount has been entered (EXTRACTED or EDITED).
      // PENDING rows have no confirmed amount yet — excluding them gives accurate figures.
      const confirmedExpenses = job.expenses.filter(e => e.pdfStatus !== 'PENDING' && e.amount != null);
      const totalExpenses = confirmedExpenses.reduce((s, e) => s + (e.amount ?? 0), 0);
      const pendingCount  = job.expenses.filter(e => e.pdfStatus === 'PENDING').length;
      const revenue = job.revenue?.amount ?? 0;
      const profit  = revenue - totalExpenses;
      const margin  = revenue > 0 ? (profit / revenue) * 100 : 0;
      return {
        jobId:         job.id,
        jobNumber:     job.jobNumber,
        title:         job.title,
        clientName:    job.clientName,
        status:        job.status,
        createdAt:     job.createdAt,
        totalExpenses,
        pendingCount,
        revenue,
        profit,
        margin,
        revenueNotes:  job.revenue?.notes ?? null,
      };
    });

    const totalRevenue   = summary.reduce((s, j) => s + j.revenue, 0);
    const totalExpenses  = summary.reduce((s, j) => s + j.totalExpenses, 0);
    const totalProfit    = totalRevenue - totalExpenses;
    const overallMargin  = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

    return {
      jobs: summary,
      totals: { totalRevenue, totalExpenses, totalProfit, overallMargin },
    };
  });

  res.json({ success: true, data });
});

export default router;
