import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { initWebSocket } from './lib/websocket';
import { errorHandler, notFound } from './middleware/errorHandler';
import prisma from './lib/prisma';
import { sendTimerAlert, sendSubTaskTimerAlert } from './services/whatsapp';
import { startWorkflow } from './services/workflow';

import dashboardRouter from './routes/dashboard';
import usersRouter from './routes/users';
import jobsRouter from './routes/jobs';
import workflowsRouter from './routes/workflows';
import webhooksRouter from './routes/webhooks';
import messagesRouter from './routes/messages';
import analyticsRouter from './routes/analytics';
import settingsRouter from './routes/settings';
import authRouter from './routes/auth';
import financeRouter from './routes/finance';
import projectsRouter from './routes/projects';

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Security & parsing ───────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:3000',
].filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, health checks)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
};

app.use(helmet());
app.options('*', cors(corsOptions)); // handle preflight for all routes
app.use(cors(corsOptions));
app.use(morgan('dev'));

// WhatsApp webhook from Twilio sends application/x-www-form-urlencoded
app.use('/api/webhooks', express.urlencoded({ extended: false }));
// Capture the raw JSON body so Meta's X-Hub-Signature-256 can be verified against it
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Public routes
app.use('/api/auth',     authRouter);
app.use('/api/webhooks', webhooksRouter);

// API routes (internal tool – protected at frontend)
app.use('/api/dashboard',          dashboardRouter);
app.use('/api/users',              usersRouter);
app.use('/api/jobs',               jobsRouter);
app.use('/api/projects',           projectsRouter);
app.use('/api/workflow-templates', workflowsRouter);
app.use('/api/messages',           messagesRouter);
app.use('/api/analytics',          analyticsRouter);
app.use('/api/settings',           settingsRouter);
app.use('/api/finance',            financeRouter);

// ─── Error handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app);
initWebSocket(server);

// ─── Background: Timer Expiry Checker ────────────────────────────────────────
// Runs every 60 seconds. Finds steps whose timer has expired but alert not yet sent.
// Sends WhatsApp to the assigned worker (in their language) + admin, then marks step.
async function checkExpiredTimers(): Promise<void> {
  try {
    const now = new Date();

    // Check step timers
    const expiredSteps = await prisma.workflowStep.findMany({
      where: {
        timerStartedAt: { not: null },
        durationMinutes: { not: null },
        timerAlertSentAt: null,
        status: { in: ['IN_PROGRESS', 'NOTIFIED', 'WAITING'] },
      },
      select: { id: true, timerStartedAt: true, durationMinutes: true },
    });

    for (const step of expiredSteps) {
      if (!step.timerStartedAt || !step.durationMinutes) continue;
      const expiresAt = new Date(step.timerStartedAt.getTime() + step.durationMinutes * 60 * 1000);
      if (now >= expiresAt) {
        await sendTimerAlert(step.id);
      }
    }

    // Check sub-task timers
    const expiredSubTasks = await prisma.workflowSubTask.findMany({
      where: {
        timerStartedAt: { not: null },
        durationMinutes: { not: null },
        timerAlertSentAt: null,
        status: { in: ['WAITING', 'NOTIFIED'] },
      },
      select: { id: true, timerStartedAt: true, durationMinutes: true },
    });

    for (const st of expiredSubTasks) {
      if (!st.timerStartedAt || !st.durationMinutes) continue;
      const expiresAt = new Date(st.timerStartedAt.getTime() + st.durationMinutes * 60 * 1000);
      if (now >= expiresAt) {
        await sendSubTaskTimerAlert(st.id);
      }
    }
  } catch (err) {
    console.error('[Timer Checker] Error:', err);
  }
}

// ─── Background: Auto-start Workflow by Start Date ───────────────────────────
// Runs every 5 minutes. Finds jobs whose startDate is today and workflow not started.
// If autoStart is ON  → starts the workflow automatically.
// If autoStart is OFF → sends an alert to the Alerts panel so admin is reminded to start manually.
async function checkAutoStartJobs(): Promise<void> {
  try {
    const settings = await prisma.systemSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const jobs = await prisma.job.findMany({
      where: {
        startDate: { gte: todayStart, lte: todayEnd },
        status: 'PENDING',
      },
      include: { workflowSteps: { orderBy: { stepNumber: 'asc' } } },
    });

    for (const job of jobs) {
      if (job.workflowSteps.length === 0) continue;

      if (settings.autoStartOnDate) {
        console.log(`[Auto-start] Starting workflow for job ${job.jobNumber}`);
        await startWorkflow(job.id);
        await prisma.auditLog.create({
          data: {
            jobId: job.id,
            eventType: 'WORKFLOW_AUTO_STARTED',
            description: `Workflow auto-started on scheduled start date for job #${job.jobNumber}`,
          },
        });
      } else {
        // Check we haven't already sent this reminder today
        const alreadyAlerted = await prisma.auditLog.findFirst({
          where: {
            jobId: job.id,
            eventType: 'AUTO_START_REMINDER',
            createdAt: { gte: todayStart },
          },
        });
        if (!alreadyAlerted) {
          console.log(`[Auto-start] Sending reminder for job ${job.jobNumber} (auto-start disabled)`);
          await prisma.auditLog.create({
            data: {
              jobId: job.id,
              eventType: 'AUTO_START_REMINDER',
              description: `Job #${job.jobNumber} was scheduled to start today but auto-start is disabled. Please start the workflow manually.`,
            },
          });
        }
      }
    }
  } catch (err) {
    console.error('[Auto-start Checker] Error:', err);
  }
}

const AUTO_START_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
setInterval(checkAutoStartJobs, AUTO_START_CHECK_INTERVAL_MS);
checkAutoStartJobs(); // run once at startup

const TIMER_CHECK_INTERVAL_MS = 60 * 1000; // every 60 seconds
setInterval(checkExpiredTimers, TIMER_CHECK_INTERVAL_MS);
checkExpiredTimers(); // run once at startup

server.listen(PORT, () => {
  console.log(`\n🏗️  Stone Co Backend running on http://localhost:${PORT}`);
  console.log(`📡  WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`🌍  Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

export default app;
