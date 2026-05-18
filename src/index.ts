import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { initWebSocket } from './lib/websocket';
import { errorHandler, notFound } from './middleware/errorHandler';

import dashboardRouter from './routes/dashboard';
import usersRouter from './routes/users';
import jobsRouter from './routes/jobs';
import workflowsRouter from './routes/workflows';
import webhooksRouter from './routes/webhooks';
import messagesRouter from './routes/messages';
import analyticsRouter from './routes/analytics';
import settingsRouter from './routes/settings';
import authRouter from './routes/auth';

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
app.use(express.json({ limit: '10mb' }));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Public routes
app.use('/api/auth',     authRouter);
app.use('/api/webhooks', webhooksRouter);

// API routes (internal tool – protected at frontend)
app.use('/api/dashboard',          dashboardRouter);
app.use('/api/users',              usersRouter);
app.use('/api/jobs',               jobsRouter);
app.use('/api/workflow-templates', workflowsRouter);
app.use('/api/messages',           messagesRouter);
app.use('/api/analytics',          analyticsRouter);
app.use('/api/settings',           settingsRouter);

// ─── Error handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app);
initWebSocket(server);

server.listen(PORT, () => {
  console.log(`\n🏗️  Stone Co Backend running on http://localhost:${PORT}`);
  console.log(`📡  WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`🌍  Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

export default app;
