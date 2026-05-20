import twilio from 'twilio';
import prisma from '../lib/prisma';
import { broadcastEvent } from '../lib/websocket';

const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
const authToken = process.env.TWILIO_AUTH_TOKEN || '';
const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

let twilioClient: ReturnType<typeof twilio> | null = null;

type DeliveryOptions = {
  simulate?: boolean;
};

function getClient() {
  if (!twilioClient && accountSid && authToken) {
    twilioClient = twilio(accountSid, authToken);
  }
  return twilioClient;
}

async function getSystemSettings() {
  return prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
}

type MsgFn = (job: string, step: string, desc: string) => string;
type TimerMsgFn = (job: string, step: string, minutes: number) => string;

const STEP_MESSAGES: Record<string, Record<string, MsgFn>> = {
  ENGLISH: {
    assigned: (job: string, step: string, desc: string) =>
      `🏗️ *Stone Co – Job #${job}*\n\nYou have been assigned:\n*${step}*\n${desc}\n\nReply:\n✅ *DONE* – Task completed\n⚠️ *ISSUE* – Report a problem\n🆘 *HELP* – Need assistance`,
  },
  BANGLA: {
    assigned: (job: string, step: string, desc: string) =>
      `🏗️ *স্টোন কোম্পানি – কাজ #${job}*\n\nআপনাকে দেওয়া হয়েছে:\n*${step}*\n${desc}\n\nউত্তর দিন:\n✅ *DONE* – কাজ শেষ\n⚠️ *ISSUE* – সমস্যা জানান\n🆘 *HELP* – সাহায্য দরকার`,
  },
  MANDARIN: {
    assigned: (job: string, step: string, desc: string) =>
      `🏗️ *石材公司 – 工作 #${job}*\n\n您已被分配：\n*${step}*\n${desc}\n\n请回复：\n✅ *DONE* – 任务完成\n⚠️ *ISSUE* – 报告问题\n🆘 *HELP* – 需要帮助`,
  },
  BAHASA_MALAY: {
    assigned: (job: string, step: string, desc: string) =>
      `🏗️ *Syarikat Batu – Kerja #${job}*\n\nAnda telah ditugaskan:\n*${step}*\n${desc}\n\nBalas:\n✅ *DONE* – Tugasan selesai\n⚠️ *ISSUE* – Laporkan masalah\n🆘 *HELP* – Perlukan bantuan`,
  },
  TAMIL: {
    assigned: (job: string, step: string, desc: string) =>
      `🏗️ *ஸ்டோன் கம்பெனி – வேலை #${job}*\n\nதங்களுக்கு ஒதுக்கப்பட்டது:\n*${step}*\n${desc}\n\nபதில் அனுப்புங்கள்:\n✅ *DONE* – வேலை முடிந்தது\n⚠️ *ISSUE* – பிரச்சனை தெரிவிக்கவும்\n🆘 *HELP* – உதவி தேவை`,
  },
};

// Timer expiry messages per language — sent to WORKER when time is up
const TIMER_WORKER_MESSAGES: Record<string, TimerMsgFn> = {
  ENGLISH: (job, step, minutes) =>
    `⏰ *Time Alert – Job #${job}*\n\n*${step}* was given ${minutes} minutes.\n\nTime is up! Please update your status now:\n✅ *DONE* – Task completed\n⚠️ *ISSUE* – Report a problem\n🆘 *HELP* – Need assistance`,
  BANGLA: (job, step, minutes) =>
    `⏰ *সময় সতর্কতা – কাজ #${job}*\n\n*${step}* এর জন্য ${minutes} মিনিট সময় দেওয়া হয়েছিল।\n\nসময় শেষ! এখনই আপনার অবস্থা জানান:\n✅ *DONE* – কাজ শেষ\n⚠️ *ISSUE* – সমস্যা জানান\n🆘 *HELP* – সাহায্য দরকার`,
  MANDARIN: (job, step, minutes) =>
    `⏰ *时间提醒 – 工作 #${job}*\n\n*${step}* 分配了 ${minutes} 分钟。\n\n时间到了！请立即更新状态：\n✅ *DONE* – 任务完成\n⚠️ *ISSUE* – 报告问题\n🆘 *HELP* – 需要帮助`,
  BAHASA_MALAY: (job, step, minutes) =>
    `⏰ *Amaran Masa – Kerja #${job}*\n\n*${step}* diberi ${minutes} minit.\n\nMasa tamat! Sila kemas kini status anda sekarang:\n✅ *DONE* – Tugasan selesai\n⚠️ *ISSUE* – Laporkan masalah\n🆘 *HELP* – Perlukan bantuan`,
  TAMIL: (job, step, minutes) =>
    `⏰ *நேர எச்சரிக்கை – வேலை #${job}*\n\n*${step}* க்கு ${minutes} நிமிடங்கள் கொடுக்கப்பட்டது.\n\nநேரம் முடிந்தது! இப்போதே உங்கள் நிலையை தெரிவிக்கவும்:\n✅ *DONE* – வேலை முடிந்தது\n⚠️ *ISSUE* – பிரச்சனை தெரிவிக்கவும்\n🆘 *HELP* – உதவி தேவை`,
};

function buildMessage(
  language: string,
  jobNumber: string,
  stepName: string,
  description: string,
): string {
  const lang = STEP_MESSAGES[language] || STEP_MESSAGES['ENGLISH'];
  const fn = lang['assigned'] || STEP_MESSAGES['ENGLISH']['assigned'];
  return fn(jobNumber, stepName, description || '');
}

export async function sendStepNotification(stepId: string, options: DeliveryOptions = {}): Promise<void> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: {
      job: true,
      assignedUser: true,
    },
  });

  if (!step || !step.assignedUser) {
    console.warn('[WhatsApp] Step or user not found:', stepId);
    return;
  }

  const message = buildMessage(
    step.assignedUser.language,
    step.job.jobNumber,
    step.name,
    step.description || '',
  );

  const to = `whatsapp:${step.assignedUser.phone}`;
  const client = getClient();

  if (options.simulate || !client) {
    console.log(options.simulate ? '[WhatsApp] SIMULATION – Would send to:' : '[WhatsApp] DEMO MODE – Would send to:', to);
    console.log('[WhatsApp] Message:', message);
    await prisma.whatsAppMessage.create({
      data: {
        jobId: step.jobId,
        stepId: step.id,
        userId: step.assignedUserId,
        direction: 'OUTBOUND',
        content: message,
        status: options.simulate ? 'simulated' : 'demo_sent',
      },
    });
    return;
  }

  try {
    const result = await client.messages.create({ from, to, body: message });
    await prisma.whatsAppMessage.create({
      data: {
        jobId: step.jobId,
        stepId: step.id,
        userId: step.assignedUserId,
        direction: 'OUTBOUND',
        waMessageId: result.sid,
        content: message,
        status: 'sent',
      },
    });
    console.log('[WhatsApp] Sent SID:', result.sid);
  } catch (err) {
    console.error('[WhatsApp] Send error:', err);
    // Save as failed — do NOT throw. Workflow must continue regardless of WhatsApp errors.
    await prisma.whatsAppMessage.create({
      data: {
        jobId: step.jobId,
        stepId: step.id,
        userId: step.assignedUserId,
        direction: 'OUTBOUND',
        content: message,
        status: 'failed',
      },
    });
  }
}

// Send a plain text reply back to a WhatsApp number (fire-and-forget, never throws)
async function sendReply(to: string, message: string, options: DeliveryOptions = {}): Promise<void> {
  if (options.simulate) {
    console.log('[WhatsApp] SIMULATED REPLY to', to, ':', message);
    return;
  }

  const client = getClient();
  if (!client) {
    console.log('[WhatsApp] DEMO REPLY to', to, ':', message);
    return;
  }
  try {
    await client.messages.create({ from, to, body: message });
  } catch (err) {
    console.error('[WhatsApp] Reply send error:', err);
  }
}

// Notify the admin when a worker reports ISSUE or HELP
async function notifyAdmin(
  job: { id: string; jobNumber: string; title: string },
  step: { id: string; name: string },
  worker: { name: string; phone: string },
  type: 'ISSUE' | 'HELP',
  details: string,
  options: DeliveryOptions = {},
): Promise<void> {
  const settings = await getSystemSettings();
  if (!settings.notifyAdmin) return;

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', isActive: true, phone: { not: '' } },
  });
  if (!admin?.phone) return;

  const emoji = type === 'ISSUE' ? '⚠️' : '🆘';
  const label = type === 'ISSUE' ? 'ISSUE REPORTED' : 'HELP REQUESTED';
  const msg =
    `${emoji} *${label}*\n\n` +
    `Job: *#${job.jobNumber}* – ${job.title}\n` +
    `Step: *${step.name}*\n` +
    `Worker: ${worker.name} (${worker.phone})\n` +
    `Details: ${details}\n\n` +
    `Reply *${job.jobNumber}: <your message>* to respond to worker\n` +
    `Reply *RESOLVE ${job.jobNumber}* to clear the issue`;

  await sendReply(`whatsapp:${admin.phone}`, msg, options);
}

// Handle messages sent BY admin (route reply to worker or resolve issue)
async function handleAdminMessage(
  admin: { id: string; name: string; phone: string; role: string },
  body: string,
  waMessageId: string,
): Promise<void> {
  const adminTo = `whatsapp:${admin.phone}`;
  const text = body.trim();

  // RESOLVE J001 — admin resolves an open issue
  const resolveMatch = text.match(/^RESOLVE\s+([A-Z0-9][A-Z0-9-]*)/i);
  if (resolveMatch) {
    const jobNumber = resolveMatch[1].toUpperCase();
    const job = await prisma.job.findFirst({ where: { jobNumber } });
    if (!job) {
      await sendReply(adminTo, `❌ Job #${jobNumber} not found.`);
      return;
    }
    const step = await prisma.workflowStep.findFirst({
      where: { jobId: job.id, status: { in: ['ISSUE', 'HELP_NEEDED'] } },
      include: { assignedUser: true },
      orderBy: { stepNumber: 'asc' },
    });
    if (!step) {
      await sendReply(adminTo, `✅ No open issues found for Job #${jobNumber}.`);
      return;
    }
    await prisma.workflowStep.update({
      where: { id: step.id },
      data: { status: 'IN_PROGRESS' },
    });
    await prisma.auditLog.create({
      data: {
        jobId: job.id,
        stepId: step.id,
        userId: admin.id,
        eventType: 'ISSUE_RESOLVED',
        description: `Admin ${admin.name} resolved the issue on "${step.name}"`,
      },
    });
    broadcastEvent('issue_resolved', { jobId: job.id, stepId: step.id });
    if (step.assignedUser) {
      await sendReply(
        `whatsapp:${step.assignedUser.phone}`,
        `✅ Issue on *${step.name}* (Job #${job.jobNumber}) has been resolved by admin.\n\nPlease continue and reply *DONE* when finished.`,
      );
    }
    await sendReply(adminTo, `✅ Issue resolved for Job #${jobNumber}. Worker has been notified.`);
    return;
  }

  // J001: message — admin replies to a worker
  const replyMatch = text.match(/^([A-Z0-9][A-Z0-9-]*):\s*(.+)/is);
  if (replyMatch) {
    const jobNumber = replyMatch[1].toUpperCase();
    const message = replyMatch[2].trim();
    const job = await prisma.job.findFirst({ where: { jobNumber } });
    if (!job) {
      await sendReply(adminTo, `❌ Job #${jobNumber} not found.`);
      return;
    }
    const step = await prisma.workflowStep.findFirst({
      where: {
        jobId: job.id,
        status: { in: ['ISSUE', 'HELP_NEEDED', 'NOTIFIED', 'IN_PROGRESS'] },
      },
      include: { assignedUser: true },
      orderBy: { stepNumber: 'asc' },
    });
    if (!step?.assignedUser) {
      await sendReply(adminTo, `❌ No active worker found for Job #${jobNumber}.`);
      return;
    }

    // Save admin's message as INBOUND (from admin's perspective to system)
    await prisma.whatsAppMessage.create({
      data: {
        jobId: job.id,
        stepId: step.id,
        userId: admin.id,
        direction: 'INBOUND',
        waMessageId,
        content: body,
        status: 'received',
      },
    });

    // Forward to worker with a beautiful multilingual-aware template
    const workerMsg = buildAdminReplyMessage(
      step.assignedUser.language,
      job.jobNumber,
      step.name,
      message,
    );
    await sendReply(`whatsapp:${step.assignedUser.phone}`, workerMsg);
    await prisma.whatsAppMessage.create({
      data: {
        jobId: job.id,
        stepId: step.id,
        userId: step.assignedUser.id,
        direction: 'OUTBOUND',
        content: workerMsg,
        status: 'sent',
      },
    });

    await sendReply(adminTo, `✅ Message sent to ${step.assignedUser.name}.`);
    return;
  }

  // Unknown — help text
  await sendReply(
    adminTo,
    `❓ To respond to a worker, reply:\n*J001: <your message>*\n\nTo resolve an issue:\n*RESOLVE J001*`,
  );
}

// ─── Beautiful admin-reply template (multilingual) ────────────────────────────
type AdminReplyFn = (job: string, step: string, msg: string) => string;

const ADMIN_REPLY_MESSAGES: Record<string, AdminReplyFn> = {
  ENGLISH: (job, step, msg) =>
    `📩 *Message from Admin*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏗️ Job *#${job}* · ${step}\n\n` +
    `${msg}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Please reply with one of:\n` +
    `✅ *DONE* – Task completed\n` +
    `⚠️ *ISSUE <details>* – Report a problem\n` +
    `🆘 *HELP* – Need assistance`,
  BANGLA: (job, step, msg) =>
    `📩 *অ্যাডমিনের বার্তা*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏗️ কাজ *#${job}* · ${step}\n\n` +
    `${msg}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `নিচের একটি উত্তর দিন:\n` +
    `✅ *DONE* – কাজ শেষ\n` +
    `⚠️ *ISSUE <বিবরণ>* – সমস্যা জানান\n` +
    `🆘 *HELP* – সাহায্য দরকার`,
  MANDARIN: (job, step, msg) =>
    `📩 *管理员消息*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏗️ 工作 *#${job}* · ${step}\n\n` +
    `${msg}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `请回复以下之一：\n` +
    `✅ *DONE* – 任务完成\n` +
    `⚠️ *ISSUE <详情>* – 报告问题\n` +
    `🆘 *HELP* – 需要帮助`,
  BAHASA_MALAY: (job, step, msg) =>
    `📩 *Mesej daripada Admin*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏗️ Kerja *#${job}* · ${step}\n\n` +
    `${msg}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Sila balas dengan salah satu:\n` +
    `✅ *DONE* – Tugasan selesai\n` +
    `⚠️ *ISSUE <butiran>* – Laporkan masalah\n` +
    `🆘 *HELP* – Perlukan bantuan`,
  TAMIL: (job, step, msg) =>
    `📩 *நிர்வாகியின் செய்தி*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏗️ வேலை *#${job}* · ${step}\n\n` +
    `${msg}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `கீழுள்ள ஒன்றில் பதிலளிக்கவும்:\n` +
    `✅ *DONE* – வேலை முடிந்தது\n` +
    `⚠️ *ISSUE <விவரங்கள்>* – பிரச்சனை தெரிவிக்கவும்\n` +
    `🆘 *HELP* – உதவி தேவை`,
};

function buildAdminReplyMessage(language: string, jobNumber: string, stepName: string, message: string): string {
  const fn = ADMIN_REPLY_MESSAGES[language] || ADMIN_REPLY_MESSAGES['ENGLISH'];
  return fn(jobNumber, stepName, message);
}

// Send admin reply directly to a specific step's worker (used from UI dashboard)
export async function sendAdminReplyToStep(
  stepId: string,
  adminId: string,
  message: string,
): Promise<{ workerName: string; jobNumber: string }> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: { job: true, assignedUser: true },
  });
  if (!step || !step.assignedUser) throw new Error('Step or worker not found');

  const workerMsg = buildAdminReplyMessage(
    step.assignedUser.language,
    step.job.jobNumber,
    step.name,
    message,
  );

  await sendReply(`whatsapp:${step.assignedUser.phone}`, workerMsg);

  await prisma.whatsAppMessage.create({
    data: {
      jobId: step.jobId,
      stepId: step.id,
      userId: step.assignedUserId,
      direction: 'OUTBOUND',
      content: workerMsg,
      status: 'sent',
    },
  });

  await prisma.auditLog.create({
    data: {
      jobId: step.jobId,
      stepId: step.id,
      userId: adminId,
      eventType: 'ADMIN_REPLY',
      description: `Admin replied to ${step.assignedUser.name} on "${step.name}": ${message}`,
    },
  });

  broadcastEvent('admin_replied', { jobId: step.jobId, stepId: step.id });

  return { workerName: step.assignedUser.name, jobNumber: step.job.jobNumber };
}

// Resolve a step issue directly by stepId (used from UI dashboard)
export async function resolveStepById(
  stepId: string,
  adminId: string,
): Promise<{ workerName: string; jobNumber: string; stepName: string }> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: { job: true, assignedUser: true },
  });
  if (!step) throw new Error('Step not found');

  await prisma.workflowStep.update({
    where: { id: step.id },
    data: { status: 'IN_PROGRESS', issueText: null },
  });

  await prisma.auditLog.create({
    data: {
      jobId: step.jobId,
      stepId: step.id,
      userId: adminId,
      eventType: 'ISSUE_RESOLVED',
      description: `Admin resolved issue on "${step.name}"`,
    },
  });

  broadcastEvent('issue_resolved', { jobId: step.jobId, stepId: step.id });

  if (step.assignedUser) {
    const resolveMsg = buildAdminReplyMessage(
      step.assignedUser.language,
      step.job.jobNumber,
      step.name,
      '✅ Issue resolved by admin. Please continue with the task.',
    );
    await sendReply(`whatsapp:${step.assignedUser.phone}`, resolveMsg);
  }

  return {
    workerName: step.assignedUser?.name ?? 'Worker',
    jobNumber: step.job.jobNumber,
    stepName: step.name,
  };
}

// Called from the UI (admin-send API) — no WhatsApp number needed
export async function handleAdminMessageById(adminId: string, text: string): Promise<void> {
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  if (!admin) return;
  // Reuse same logic — use a fake waMessageId for UI-originated messages
  await handleAdminMessage(admin, text, `ui-${Date.now()}`);
}

// Called from the dashboard /raise endpoint — sends the same admin alert WhatsApp
// as when a worker replies ISSUE/HELP via WhatsApp.
export async function sendRaisedIssueAlert(
  job: { id: string; jobNumber: string; title: string },
  step: { id: string; name: string },
  raisedBy: { name: string; phone: string } | null,
  type: 'ISSUE' | 'HELP',
  details: string,
): Promise<void> {
  const workerInfo = raisedBy ?? { name: 'Admin', phone: '' };
  await notifyAdmin(job, step, workerInfo, type, details);
}

export async function handleInboundMessage(
  from: string,
  body: string,
  waMessageId: string,
  options: { simulateOutbound?: boolean } = {},
): Promise<void> {
  const phone = from.replace('whatsapp:', '');
  const to = `whatsapp:${phone}`;   // used for sending replies back
  const text = body.trim().toUpperCase();

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    console.warn('[WhatsApp] Unknown sender:', phone);
    return;
  }

  const activeStep = await prisma.workflowStep.findFirst({
    where: {
      assignedUserId: user.id,
      // Include ISSUE/HELP_NEEDED so workers can escalate or change their alert type
      status: { in: ['NOTIFIED', 'IN_PROGRESS', 'ISSUE', 'HELP_NEEDED'] },
    },
    include: { job: true },
    orderBy: { stepNumber: 'asc' },
  });

  // Admin messages: if admin has an active assigned step AND sends a worker command,
  // process as worker. Otherwise route to admin relay handler.
  if (user.role === 'ADMIN') {
    const isWorkerCommand = text === 'DONE' || text.startsWith('ISSUE') || text.startsWith('HELP');
    if (!activeStep || !isWorkerCommand) {
      await handleAdminMessage(user, body, waMessageId);
      return;
    }
  } else if (!activeStep) {
    console.warn('[WhatsApp] No active step for user:', user.name);
    return;
  }

  await prisma.whatsAppMessage.create({
    data: {
      jobId: activeStep.jobId,
      stepId: activeStep.id,
      userId: user.id,
      direction: 'INBOUND',
      waMessageId,
      content: body,
      status: 'received',
    },
  });

  if (text === 'DONE') {
    const { advanceWorkflow } = await import('./workflow');
    await advanceWorkflow(activeStep.jobId, activeStep.id, { simulateOutbound: options.simulateOutbound });
  } else if (text.startsWith('ISSUE')) {
    // Support "ISSUE" alone or "ISSUE <details>"
    const details = body.trim().replace(/^ISSUE\s*/i, '').trim() || 'No details provided';
    await prisma.workflowStep.update({
      where: { id: activeStep.id },
      data: { status: 'ISSUE', issueText: details },
    });
    await prisma.auditLog.create({
      data: {
        jobId: activeStep.jobId,
        stepId: activeStep.id,
        userId: user.id,
        eventType: 'STEP_ISSUE',
        description: `${user.name} reported an issue on "${activeStep.name}": ${details}`,
      },
    });
    broadcastEvent('step_issue', { jobId: activeStep.jobId, stepId: activeStep.id, details });
    await notifyAdmin(activeStep.job, activeStep, user, 'ISSUE', details, { simulate: options.simulateOutbound });
    // Confirm receipt back to worker
    await sendReply(to, `⚠️ Issue reported for *${activeStep.name}* on Job #${activeStep.job.jobNumber}.\n\nDetails: ${details}\n\nThe admin has been notified. Please wait for further instructions.`, { simulate: options.simulateOutbound });
  } else if (text.startsWith('HELP')) {
    const details = body.trim().replace(/^HELP\s*/i, '').trim();
    await prisma.workflowStep.update({
      where: { id: activeStep.id },
      data: { status: 'HELP_NEEDED', issueText: details || 'Worker requested help' },
    });
    await prisma.auditLog.create({
      data: {
        jobId: activeStep.jobId,
        stepId: activeStep.id,
        userId: user.id,
        eventType: 'STEP_HELP',
        description: `${user.name} requested help on "${activeStep.name}"${details ? ': ' + details : ''}`,
      },
    });
    broadcastEvent('step_help', { jobId: activeStep.jobId, stepId: activeStep.id, details });
    await notifyAdmin(activeStep.job, activeStep, user, 'HELP', details || 'Worker requested help', { simulate: options.simulateOutbound });
    // Confirm receipt back to worker
    await sendReply(to, `🆘 Help request received for *${activeStep.name}* on Job #${activeStep.job.jobNumber}.\n\nThe admin will contact you shortly.`, { simulate: options.simulateOutbound });
  } else {
    // Unrecognised — guide the worker
    await sendReply(to, `❓ Unrecognised reply: "${body.trim()}"\n\nPlease reply with:\n✅ *DONE* – Task completed\n⚠️ *ISSUE <details>* – Report a problem\n🆘 *HELP* – Need assistance`, { simulate: options.simulateOutbound });
  }
}

// ─── Timer Expiry Alert ────────────────────────────────────────────────────────
// Called by the background timer checker in index.ts.
// Sends WhatsApp to the assigned worker (in their language) and to the admin.
// Marks timerAlertSentAt so we only send once per expired timer.
export async function sendTimerAlert(stepId: string, options: DeliveryOptions = {}): Promise<void> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: {
      job: true,
      assignedUser: true,
    },
  });

  if (!step || !step.assignedUser || !step.timerStartedAt || !step.durationMinutes) return;
  // Already alerted — skip
  if (step.timerAlertSentAt) return;

  // Mark alert sent immediately to prevent race conditions
  await prisma.workflowStep.update({
    where: { id: stepId },
    data: { timerAlertSentAt: new Date() },
  });

  const lang = step.assignedUser.language || 'ENGLISH';
  const msgFn = TIMER_WORKER_MESSAGES[lang] || TIMER_WORKER_MESSAGES['ENGLISH'];
  const workerMsg = msgFn(step.job.jobNumber, step.name, step.durationMinutes);

  // Send to worker
  const workerTo = `whatsapp:${step.assignedUser.phone}`;
  const client = getClient();

  if (options.simulate || !client) {
    console.log('[WhatsApp] TIMER ALERT to worker:', workerTo);
    console.log('[WhatsApp] Message:', workerMsg);
  } else {
    try {
      await client.messages.create({ from, to: workerTo, body: workerMsg });
    } catch (err) {
      console.error('[WhatsApp] Timer alert to worker failed:', err);
    }
  }

  // Log in DB
  await prisma.whatsAppMessage.create({
    data: {
      jobId: step.jobId,
      stepId: step.id,
      userId: step.assignedUserId,
      direction: 'OUTBOUND',
      content: workerMsg,
      status: options.simulate ? 'simulated' : (client ? 'sent' : 'demo_sent'),
    },
  });

  // Send to admin
  const settings = await getSystemSettings();
  if (settings.notifyAdmin) {
    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN', isActive: true, phone: { not: '' } },
    });
    if (admin?.phone) {
      const adminMsg =
        `⏰ *Timer Expired – Job #${step.job.jobNumber}*\n\n` +
        `Step: *${step.name}*\n` +
        `Worker: ${step.assignedUser.name} (${step.assignedUser.phone})\n` +
        `Allocated: ${step.durationMinutes} minutes\n\n` +
        `The worker has been notified via WhatsApp.\n` +
        `Reply *RESOLVE ${step.job.jobNumber}* if issue is handled.`;
      await sendReply(`whatsapp:${admin.phone}`, adminMsg, options);
    }
  }

  // Broadcast to UI so Timer Monitor page updates in real time
  broadcastEvent('timer_expired', {
    jobId: step.jobId,
    stepId: step.id,
    jobNumber: step.job.jobNumber,
    stepName: step.name,
    workerName: step.assignedUser.name,
  });

  console.log(`[Timer] Alert sent for step "${step.name}" (Job #${step.job.jobNumber})`);
}
