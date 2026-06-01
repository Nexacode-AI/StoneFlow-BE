import prisma from '../lib/prisma';
import { broadcastEvent } from '../lib/websocket';

const META_BASE_URL = 'https://graph.facebook.com/v20.0';

export type DeliveryResult = {
  status: 'sent' | 'failed' | 'simulated' | 'demo_sent';
  sid?: string;
  errorCode?: string | number;
  errorMessage?: string;
  to?: string;
};

type DeliveryOptions = {
  simulate?: boolean;
};

function getPhoneNumberId(): string {
  return process.env.META_PHONE_NUMBER_ID || '';
}

function getAccessToken(): string {
  return process.env.META_ACCESS_TOKEN || '';
}

function isConfigured(): boolean {
  return !!(getPhoneNumberId() && getAccessToken());
}

// Normalize any phone format to E.164 (+digits) for Meta API
function normalizePhone(phone: string): string {
  const stripped = (phone || '').replace(/^whatsapp:/i, '').trim();
  const digits = stripped.replace(/[^\d]/g, '');
  return `+${digits}`;
}

const META_LANGUAGE_CODES: Record<string, string> = {
  ENGLISH: 'en',
  BANGLA: 'bn',
  MANDARIN: 'zh_CN',
  BAHASA_MALAY: 'ms',
  TAMIL: 'ta',
};

const STEP_TEMPLATE_NAMES: Record<string, string> = {
  ENGLISH: 'step_assignment_en',
  BANGLA: 'step_assignment_bn',
  MANDARIN: 'step_assignment_zh',
  BAHASA_MALAY: 'step_assignment_ms',
  TAMIL: 'step_assignment_ta',
};

const TIMER_TEMPLATE_NAMES: Record<string, string> = {
  ENGLISH: 'timer_alert_en',
  BANGLA: 'timer_alert_bn',
  MANDARIN: 'timer_alert_zh',
  BAHASA_MALAY: 'timer_alert_ms',
  TAMIL: 'timer_alert_ta',
};

type MetaAPIResponse = {
  messages?: Array<{ id: string }>;
  error?: { message: string; code: number; type: string };
};

async function callMetaAPI(payload: object): Promise<{ messageId?: string; error?: string; errorCode?: string | number }> {
  const phoneNumberId = getPhoneNumberId();
  const accessToken = getAccessToken();

  const response = await fetch(`${META_BASE_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });

  const data = (await response.json()) as MetaAPIResponse;

  if (!response.ok || data.error) {
    return {
      error: data.error?.message || `HTTP ${response.status}`,
      errorCode: data.error?.code,
    };
  }

  return { messageId: data.messages?.[0]?.id };
}

async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParameters: string[],
): Promise<{ messageId?: string; error?: string; errorCode?: string | number }> {
  return callMetaAPI({
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: bodyParameters.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  });
}

async function sendTextMessage(
  to: string,
  text: string,
): Promise<{ messageId?: string; error?: string; errorCode?: string | number }> {
  return callMetaAPI({
    to,
    type: 'text',
    text: { body: text, preview_url: false },
  });
}

async function getSystemSettings() {
  return prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
}

// Fire-and-forget free-form text reply — used for replies within the 24h session window
async function sendReply(to: string, message: string, options: DeliveryOptions = {}): Promise<void> {
  const phone = normalizePhone(to);
  if (options.simulate) {
    console.log('[WhatsApp] SIMULATED REPLY to', phone, ':', message);
    return;
  }
  if (!isConfigured()) {
    console.log('[WhatsApp] DEMO REPLY to', phone, ':', message);
    return;
  }
  try {
    const result = await sendTextMessage(phone, message);
    if (result.error) {
      console.error(`[WhatsApp] Reply failed to ${phone} (code=${result.errorCode}): ${result.error}`);
    }
  } catch (err) {
    console.error(`[WhatsApp] Reply exception to ${phone}:`, err);
  }
}

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

  await sendReply(admin.phone, msg, options);
}

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

async function handleAdminMessage(
  admin: { id: string; name: string; phone: string; role: string },
  body: string,
  waMessageId: string,
): Promise<void> {
  const adminPhone = admin.phone;
  const text = body.trim();

  const resolveMatch = text.match(/^RESOLVE\s+([A-Z0-9][A-Z0-9-]*)/i);
  if (resolveMatch) {
    const jobNumber = resolveMatch[1].toUpperCase();
    const job = await prisma.job.findFirst({ where: { jobNumber } });
    if (!job) {
      await sendReply(adminPhone, `❌ Job #${jobNumber} not found.`);
      return;
    }
    const step = await prisma.workflowStep.findFirst({
      where: { jobId: job.id, status: { in: ['ISSUE', 'HELP_NEEDED'] } },
      include: { assignedUser: true },
      orderBy: { stepNumber: 'asc' },
    });
    if (!step) {
      await sendReply(adminPhone, `✅ No open issues found for Job #${jobNumber}.`);
      return;
    }
    await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'IN_PROGRESS' } });
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
        step.assignedUser.phone,
        `✅ Issue on *${step.name}* (Job #${job.jobNumber}) has been resolved by admin.\n\nPlease continue and reply *DONE* when finished.`,
      );
    }
    await sendReply(adminPhone, `✅ Issue resolved for Job #${jobNumber}. Worker has been notified.`);
    return;
  }

  const replyMatch = text.match(/^([A-Z0-9][A-Z0-9-]*):\s*(.+)/is);
  if (replyMatch) {
    const jobNumber = replyMatch[1].toUpperCase();
    const message = replyMatch[2].trim();
    const job = await prisma.job.findFirst({ where: { jobNumber } });
    if (!job) {
      await sendReply(adminPhone, `❌ Job #${jobNumber} not found.`);
      return;
    }
    const step = await prisma.workflowStep.findFirst({
      where: { jobId: job.id, status: { in: ['ISSUE', 'HELP_NEEDED', 'NOTIFIED', 'IN_PROGRESS'] } },
      include: { assignedUser: true },
      orderBy: { stepNumber: 'asc' },
    });
    if (!step?.assignedUser) {
      await sendReply(adminPhone, `❌ No active worker found for Job #${jobNumber}.`);
      return;
    }
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
    const workerMsg = buildAdminReplyMessage(step.assignedUser.language, job.jobNumber, step.name, message);
    await sendReply(step.assignedUser.phone, workerMsg);
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
    await sendReply(adminPhone, `✅ Message sent to ${step.assignedUser.name}.`);
    return;
  }

  await sendReply(
    adminPhone,
    `❓ To respond to a worker, reply:\n*J001: <your message>*\n\nTo resolve an issue:\n*RESOLVE J001*`,
  );
}

export async function sendStepNotification(stepId: string, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: { job: true, assignedUser: true },
  });

  if (!step || !step.assignedUser) {
    console.warn('[WhatsApp] Step or user not found:', stepId);
    return { status: 'failed', errorMessage: 'Step or assigned user not found' };
  }

  const phone = normalizePhone(step.assignedUser.phone);
  const lang = step.assignedUser.language || 'ENGLISH';
  const templateName = STEP_TEMPLATE_NAMES[lang] || STEP_TEMPLATE_NAMES['ENGLISH'];
  const langCode = META_LANGUAGE_CODES[lang] || 'en';
  const templateContent = `[Template: ${templateName}] Job #${step.job.jobNumber} | ${step.name}`;

  if (options.simulate || !isConfigured()) {
    const mode = options.simulate ? 'SIMULATION' : 'DEMO MODE';
    console.log(`[WhatsApp] ${mode} – Would send template "${templateName}" to:`, phone);
    await prisma.whatsAppMessage.create({
      data: {
        jobId: step.jobId,
        stepId: step.id,
        userId: step.assignedUserId,
        direction: 'OUTBOUND',
        content: templateContent,
        status: options.simulate ? 'simulated' : 'demo_sent',
      },
    });
    return { status: options.simulate ? 'simulated' : 'demo_sent', to: phone };
  }

  try {
    const result = await sendTemplateMessage(phone, templateName, langCode, [
      step.job.jobNumber,
      step.name,
      step.description || ' ',
    ]);

    if (result.error) throw new Error(result.error);

    await prisma.whatsAppMessage.create({
      data: {
        jobId: step.jobId,
        stepId: step.id,
        userId: step.assignedUserId,
        direction: 'OUTBOUND',
        waMessageId: result.messageId,
        content: templateContent,
        status: 'sent',
      },
    });
    console.log('[WhatsApp] Template sent, message ID:', result.messageId, 'to', phone);
    return { status: 'sent', sid: result.messageId, to: phone };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WhatsApp] sendStepNotification failed to ${phone}: ${msg}`);
    await prisma.whatsAppMessage.create({
      data: {
        jobId: step.jobId,
        stepId: step.id,
        userId: step.assignedUserId,
        direction: 'OUTBOUND',
        content: `[FAILED] ${msg}\n\n${templateContent}`,
        status: 'failed',
      },
    });
    broadcastEvent('whatsapp_failed', { jobId: step.jobId, stepId: step.id, to: phone, reason: msg });
    return { status: 'failed', errorMessage: msg, to: phone };
  }
}

export async function sendSubTaskNotification(subTaskId: string, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  const subTask = await prisma.workflowSubTask.findUnique({
    where: { id: subTaskId },
    include: { step: { include: { job: true } } },
  });

  if (!subTask || !subTask.assignedUserId) {
    return { status: 'failed', errorMessage: 'Sub-task or assigned user not found' };
  }

  const assignedUser = await prisma.user.findUnique({ where: { id: subTask.assignedUserId } });
  if (!assignedUser) return { status: 'failed', errorMessage: 'Assigned user not found' };

  const phone = normalizePhone(assignedUser.phone);
  const lang = assignedUser.language || 'ENGLISH';
  const templateName = STEP_TEMPLATE_NAMES[lang] || STEP_TEMPLATE_NAMES['ENGLISH'];
  const langCode = META_LANGUAGE_CODES[lang] || 'en';
  const label = `${subTask.step.name} › ${subTask.title}`;
  const templateContent = `[Template: ${templateName}] Job #${subTask.step.job.jobNumber} | ${label}`;

  if (options.simulate || !isConfigured()) {
    const mode = options.simulate ? 'SIMULATION' : 'DEMO MODE';
    console.log(`[WhatsApp] ${mode} – Sub-task template "${templateName}" to:`, phone);
    await prisma.whatsAppMessage.create({
      data: {
        jobId: subTask.step.jobId,
        stepId: subTask.stepId,
        userId: subTask.assignedUserId,
        direction: 'OUTBOUND',
        content: templateContent,
        status: options.simulate ? 'simulated' : 'demo_sent',
      },
    });
    return { status: options.simulate ? 'simulated' : 'demo_sent', to: phone };
  }

  try {
    const result = await sendTemplateMessage(phone, templateName, langCode, [
      subTask.step.job.jobNumber,
      label,
      subTask.description || ' ',
    ]);
    if (result.error) throw new Error(result.error);
    await prisma.whatsAppMessage.create({
      data: {
        jobId: subTask.step.jobId,
        stepId: subTask.stepId,
        userId: subTask.assignedUserId,
        direction: 'OUTBOUND',
        waMessageId: result.messageId,
        content: templateContent,
        status: 'sent',
      },
    });
    return { status: 'sent', sid: result.messageId, to: phone };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.whatsAppMessage.create({
      data: {
        jobId: subTask.step.jobId,
        stepId: subTask.stepId,
        userId: subTask.assignedUserId,
        direction: 'OUTBOUND',
        content: `[FAILED] ${msg}`,
        status: 'failed',
      },
    });
    return { status: 'failed', errorMessage: msg, to: phone };
  }
}

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

  const workerMsg = buildAdminReplyMessage(step.assignedUser.language, step.job.jobNumber, step.name, message);
  await sendReply(step.assignedUser.phone, workerMsg);

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

export async function resolveStepById(
  stepId: string,
  adminId: string,
): Promise<{ workerName: string; jobNumber: string; stepName: string }> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: { job: true, assignedUser: true },
  });
  if (!step) throw new Error('Step not found');

  await prisma.workflowStep.update({ where: { id: step.id }, data: { status: 'IN_PROGRESS', issueText: null } });
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
    await sendReply(step.assignedUser.phone, resolveMsg);
  }
  return { workerName: step.assignedUser?.name ?? 'Worker', jobNumber: step.job.jobNumber, stepName: step.name };
}

export async function sendAdminReplyToSubTask(
  subTaskId: string,
  adminId: string,
  message: string,
): Promise<{ workerName: string; jobNumber: string }> {
  const subTask = await prisma.workflowSubTask.findUnique({
    where: { id: subTaskId },
    include: { step: { include: { job: true } }, assignedUser: true },
  });
  if (!subTask || !subTask.assignedUser) throw new Error('Sub-task or worker not found');

  const workerMsg = buildAdminReplyMessage(
    subTask.assignedUser.language,
    subTask.step.job.jobNumber,
    `${subTask.step.name} › ${subTask.title}`,
    message,
  );
  await sendReply(subTask.assignedUser.phone, workerMsg);
  await prisma.whatsAppMessage.create({
    data: {
      jobId: subTask.step.jobId,
      stepId: subTask.stepId,
      userId: subTask.assignedUserId,
      direction: 'OUTBOUND',
      content: workerMsg,
      status: 'sent',
    },
  });
  await prisma.auditLog.create({
    data: {
      jobId: subTask.step.jobId,
      stepId: subTask.stepId,
      userId: adminId,
      eventType: 'ADMIN_REPLY',
      description: `Admin replied to ${subTask.assignedUser.name} on sub-task "${subTask.title}": ${message}`,
    },
  });
  broadcastEvent('admin_replied', { jobId: subTask.step.jobId, stepId: subTask.stepId });
  return { workerName: subTask.assignedUser.name, jobNumber: subTask.step.job.jobNumber };
}

export async function resolveSubTaskById(
  subTaskId: string,
  adminId: string,
): Promise<{ workerName: string; jobNumber: string; stepName: string }> {
  const subTask = await prisma.workflowSubTask.findUnique({
    where: { id: subTaskId },
    include: { step: { include: { job: true } }, assignedUser: true },
  });
  if (!subTask) throw new Error('Sub-task not found');

  await prisma.workflowSubTask.update({ where: { id: subTask.id }, data: { issueText: null } });
  await prisma.auditLog.create({
    data: {
      jobId: subTask.step.jobId,
      stepId: subTask.stepId,
      userId: adminId,
      eventType: 'ISSUE_RESOLVED',
      description: `Admin resolved issue on sub-task "${subTask.title}"`,
    },
  });
  broadcastEvent('issue_resolved', { jobId: subTask.step.jobId, stepId: subTask.stepId, subTaskId });

  if (subTask.assignedUser) {
    const resolveMsg = buildAdminReplyMessage(
      subTask.assignedUser.language,
      subTask.step.job.jobNumber,
      `${subTask.step.name} › ${subTask.title}`,
      '✅ Issue resolved by admin. Please continue with the task.',
    );
    await sendReply(subTask.assignedUser.phone, resolveMsg);
  }
  return {
    workerName: subTask.assignedUser?.name ?? 'Worker',
    jobNumber: subTask.step.job.jobNumber,
    stepName: `${subTask.step.name} › ${subTask.title}`,
  };
}

export async function handleAdminMessageById(adminId: string, text: string): Promise<void> {
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  if (!admin) return;
  await handleAdminMessage(admin, text, `ui-originated`);
}

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
  // Meta sends phone as "60123456789"; strip whatsapp: prefix if present (simulate mode uses it)
  const rawPhone = from.replace(/^whatsapp:/i, '').trim();
  const digitsOnly = rawPhone.replace(/[^\d]/g, '');
  const normalized = `+${digitsOnly}`;
  const text = body.trim().toUpperCase();

  console.log(`[WhatsApp/Inbound] from=${from} normalized=${normalized} body="${body}"`);

  let user = await prisma.user.findUnique({ where: { phone: normalized } });
  if (!user) {
    const candidates = await prisma.user.findMany();
    user = candidates.find((u) => u.phone.replace(/[^\d]/g, '') === digitsOnly) ?? null;
  }
  if (!user) {
    console.warn('[WhatsApp/Inbound] Unknown sender:', normalized);
    await sendReply(
      normalized,
      `❓ Your number (${normalized}) is not registered in the system. Please contact the admin to be added as a team member.`,
      { simulate: options.simulateOutbound },
    );
    return;
  }

  const activeSubTask = await prisma.workflowSubTask.findFirst({
    where: { assignedUserId: user.id, status: 'NOTIFIED' },
    include: { step: { include: { job: true } } },
    orderBy: { order: 'asc' },
  });

  const activeStep = await prisma.workflowStep.findFirst({
    where: {
      assignedUserId: user.id,
      status: { in: ['NOTIFIED', 'IN_PROGRESS', 'ISSUE', 'HELP_NEEDED'] },
    },
    include: { job: true },
    orderBy: { stepNumber: 'asc' },
  });

  if (activeSubTask && text === 'DONE') {
    await prisma.whatsAppMessage.create({
      data: {
        jobId: activeSubTask.step.jobId,
        stepId: activeSubTask.stepId,
        userId: user.id,
        direction: 'INBOUND',
        waMessageId,
        content: body,
        status: 'received',
      },
    });
    const { advanceSubTask } = await import('./workflow');
    await advanceSubTask(activeSubTask.step.jobId, activeSubTask.id, { simulateOutbound: options.simulateOutbound });
    await sendReply(normalized, `✅ Sub-task *${activeSubTask.title}* marked complete. Nice work!`, { simulate: options.simulateOutbound });
    return;
  }

  if (activeSubTask && (text.startsWith('ISSUE') || text.startsWith('HELP'))) {
    const isIssue = text.startsWith('ISSUE');
    const details =
      body.trim().replace(/^(ISSUE|HELP)\s*/i, '').trim() ||
      (isIssue ? 'Issue reported by worker' : 'Worker requested help');

    await prisma.whatsAppMessage.create({
      data: {
        jobId: activeSubTask.step.jobId,
        stepId: activeSubTask.stepId,
        userId: user.id,
        direction: 'INBOUND',
        waMessageId,
        content: body,
        status: 'received',
      },
    });
    await prisma.workflowSubTask.update({ where: { id: activeSubTask.id }, data: { issueText: details } });
    await prisma.auditLog.create({
      data: {
        jobId: activeSubTask.step.jobId,
        stepId: activeSubTask.stepId,
        userId: user.id,
        eventType: isIssue ? 'SUBTASK_ISSUE' : 'SUBTASK_HELP',
        description: `${user.name} ${isIssue ? 'reported an issue' : 'requested help'} on sub-task "${activeSubTask.title}": ${details}`,
      },
    });
    broadcastEvent(isIssue ? 'subtask_issue' : 'subtask_help', {
      jobId: activeSubTask.step.jobId,
      stepId: activeSubTask.stepId,
      subTaskId: activeSubTask.id,
      details,
    });
    await sendRaisedIssueAlert(
      activeSubTask.step.job,
      { id: activeSubTask.stepId, name: `${activeSubTask.step.name} › ${activeSubTask.title}` },
      { name: user.name, phone: user.phone },
      isIssue ? 'ISSUE' : 'HELP',
      details,
    );
    const replyMsg = isIssue
      ? `⚠️ Issue reported for *${activeSubTask.title}* on Job #${activeSubTask.step.job.jobNumber}.\n\nDetails: ${details}\n\nThe admin has been notified. Please wait for further instructions.`
      : `🆘 Help request received for *${activeSubTask.title}* on Job #${activeSubTask.step.job.jobNumber}.\n\nThe admin will contact you shortly.`;
    await sendReply(normalized, replyMsg, { simulate: options.simulateOutbound });
    return;
  }

  if (user.role === 'ADMIN') {
    const isWorkerCommand = text === 'DONE' || text.startsWith('ISSUE') || text.startsWith('HELP');
    if (!activeStep || !isWorkerCommand) {
      await handleAdminMessage(user, body, waMessageId);
      return;
    }
  } else if (!activeStep) {
    console.warn(`[WhatsApp/Inbound] No active step for ${user.name} (${normalized}).`);
    await sendReply(
      normalized,
      `ℹ️ Hi ${user.name}, you currently have no active task assigned. Please wait for the admin to start a workflow that includes you.`,
      { simulate: options.simulateOutbound },
    );
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
    const details = body.trim().replace(/^ISSUE\s*/i, '').trim() || 'No details provided';
    await prisma.workflowStep.update({ where: { id: activeStep.id }, data: { status: 'ISSUE', issueText: details } });
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
    await sendReply(
      normalized,
      `⚠️ Issue reported for *${activeStep.name}* on Job #${activeStep.job.jobNumber}.\n\nDetails: ${details}\n\nThe admin has been notified. Please wait for further instructions.`,
      { simulate: options.simulateOutbound },
    );
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
    await sendReply(
      normalized,
      `🆘 Help request received for *${activeStep.name}* on Job #${activeStep.job.jobNumber}.\n\nThe admin will contact you shortly.`,
      { simulate: options.simulateOutbound },
    );
  } else {
    await sendReply(
      normalized,
      `❓ Unrecognised reply: "${body.trim()}"\n\nPlease reply with:\n✅ *DONE* – Task completed\n⚠️ *ISSUE <details>* – Report a problem\n🆘 *HELP* – Need assistance`,
      { simulate: options.simulateOutbound },
    );
  }
}

export async function sendTimerAlert(stepId: string, options: DeliveryOptions = {}): Promise<void> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: { job: true, assignedUser: true },
  });

  if (!step || !step.assignedUser || !step.timerStartedAt || !step.durationMinutes) return;
  if (step.timerAlertSentAt) return;

  await prisma.workflowStep.update({ where: { id: stepId }, data: { timerAlertSentAt: new Date() } });

  const lang = step.assignedUser.language || 'ENGLISH';
  const templateName = TIMER_TEMPLATE_NAMES[lang] || TIMER_TEMPLATE_NAMES['ENGLISH'];
  const langCode = META_LANGUAGE_CODES[lang] || 'en';
  const workerPhone = normalizePhone(step.assignedUser.phone);
  const templateContent = `[Template: ${templateName}] Job #${step.job.jobNumber} | ${step.name} | ${step.durationMinutes}min`;

  if (options.simulate || !isConfigured()) {
    console.log('[WhatsApp] TIMER ALERT (demo) to:', workerPhone, templateContent);
  } else {
    try {
      await sendTemplateMessage(workerPhone, templateName, langCode, [
        step.job.jobNumber,
        step.name,
        String(step.durationMinutes),
      ]);
    } catch (err) {
      console.error(`[WhatsApp] Timer alert to worker failed:`, err);
    }
  }

  await prisma.whatsAppMessage.create({
    data: {
      jobId: step.jobId,
      stepId: step.id,
      userId: step.assignedUserId,
      direction: 'OUTBOUND',
      content: templateContent,
      status: options.simulate ? 'simulated' : isConfigured() ? 'sent' : 'demo_sent',
    },
  });

  const settings = await getSystemSettings();
  if (settings.notifyAdmin) {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true, phone: { not: '' } } });
    if (admin?.phone) {
      const adminMsg =
        `⏰ *Timer Expired – Job #${step.job.jobNumber}*\n\n` +
        `Step: *${step.name}*\n` +
        `Worker: ${step.assignedUser.name} (${step.assignedUser.phone})\n` +
        `Allocated: ${step.durationMinutes} minutes\n\n` +
        `The worker has been notified via WhatsApp.\n` +
        `Reply *RESOLVE ${step.job.jobNumber}* if issue is handled.`;
      await sendReply(admin.phone, adminMsg, options);
    }
  }

  broadcastEvent('timer_expired', {
    jobId: step.jobId,
    stepId: step.id,
    jobNumber: step.job.jobNumber,
    stepName: step.name,
    workerName: step.assignedUser.name,
  });

  console.log(`[Timer] Alert sent for step "${step.name}" (Job #${step.job.jobNumber})`);
}

export async function sendSubTaskTimerAlert(subTaskId: string, options: DeliveryOptions = {}): Promise<void> {
  const subTask = await prisma.workflowSubTask.findUnique({
    where: { id: subTaskId },
    include: { assignedUser: true, step: { include: { job: true } } },
  });

  if (!subTask || !subTask.assignedUser || !subTask.timerStartedAt || !subTask.durationMinutes) return;
  if (subTask.timerAlertSentAt) return;

  await prisma.workflowSubTask.update({ where: { id: subTaskId }, data: { timerAlertSentAt: new Date() } });

  const lang = (subTask.assignedUser.language as string) || 'ENGLISH';
  const templateName = TIMER_TEMPLATE_NAMES[lang] || TIMER_TEMPLATE_NAMES['ENGLISH'];
  const langCode = META_LANGUAGE_CODES[lang] || 'en';
  const label = `${subTask.step.name} › ${subTask.title}`;
  const workerPhone = normalizePhone(subTask.assignedUser.phone);
  const templateContent = `[Template: ${templateName}] Job #${subTask.step.job.jobNumber} | ${label}`;

  if (options.simulate || !isConfigured()) {
    console.log('[WhatsApp] SUBTASK TIMER ALERT (demo) to:', workerPhone, templateContent);
  } else {
    try {
      await sendTemplateMessage(workerPhone, templateName, langCode, [
        subTask.step.job.jobNumber,
        label,
        String(subTask.durationMinutes),
      ]);
    } catch (err) {
      console.error(`[WhatsApp] Sub-task timer alert failed:`, err);
    }
  }

  await prisma.whatsAppMessage.create({
    data: {
      jobId: subTask.step.jobId,
      stepId: subTask.stepId,
      userId: subTask.assignedUserId,
      direction: 'OUTBOUND',
      content: templateContent,
      status: options.simulate ? 'simulated' : isConfigured() ? 'sent' : 'demo_sent',
    },
  });

  const settings = await getSystemSettings();
  if (settings.notifyAdmin) {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true, phone: { not: '' } } });
    if (admin?.phone) {
      const adminMsg =
        `⏰ *Sub-task Timer Expired – Job #${subTask.step.job.jobNumber}*\n\n` +
        `Step: *${subTask.step.name}*\n` +
        `Sub-task: *${subTask.title}*\n` +
        `Worker: ${subTask.assignedUser.name} (${subTask.assignedUser.phone})\n` +
        `Allocated: ${subTask.durationMinutes} minutes\n\n` +
        `The worker has been notified via WhatsApp.`;
      await sendReply(admin.phone, adminMsg, options);
    }
  }

  broadcastEvent('subtask_timer_expired', {
    jobId: subTask.step.jobId,
    stepId: subTask.stepId,
    subTaskId,
    jobNumber: subTask.step.job.jobNumber,
    title: subTask.title,
    workerName: subTask.assignedUser.name,
  });

  console.log(`[Timer] Sub-task alert sent: "${subTask.title}" (Job #${subTask.step.job.jobNumber})`);
}

export async function sendTestMessage(rawPhone: string, customBody?: string): Promise<DeliveryResult> {
  const phone = normalizePhone(rawPhone);

  if (!isConfigured()) {
    return {
      status: 'demo_sent',
      to: phone,
      errorMessage: 'META_PHONE_NUMBER_ID or META_ACCESS_TOKEN are missing in backend/.env — running in DEMO mode.',
    };
  }

  const body =
    customBody?.trim() ||
    `🧪 *Stone Co – WhatsApp Test*\n\nIf you can read this, your Meta Cloud API + webhook are wired correctly.\n\nReply *DONE* to confirm two-way delivery.`;

  try {
    const result = await sendTextMessage(phone, body);
    if (result.error) {
      return { status: 'failed', to: phone, errorCode: result.errorCode, errorMessage: result.error };
    }
    return { status: 'sent', sid: result.messageId, to: phone };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', to: phone, errorMessage: msg };
  }
}
