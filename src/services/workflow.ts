import prisma from '../lib/prisma';
import { broadcastEvent } from '../lib/websocket';
import { sendStepNotification, sendSubTaskNotification, DeliveryResult } from './whatsapp';

type WorkflowDispatchOptions = {
  simulateOutbound?: boolean;
};

export type WorkflowStartResult = {
  firstStepId: string;
  notification: DeliveryResult | null;
};

// ─── Internal helper: Start a step (handles both sub-task and regular steps) ──
// If the step has WAITING sub-tasks → step goes IN_PROGRESS, first sub-task is NOTIFIED.
// Otherwise → step goes NOTIFIED and the step's own worker is notified (classic).
async function startStep(
  step: { id: string; stepNumber: number; assignedUserId?: string | null },
  jobId: string,
  options: WorkflowDispatchOptions,
): Promise<DeliveryResult | null> {
  const firstSubTask = await prisma.workflowSubTask.findFirst({
    where: { stepId: step.id, status: 'WAITING' },
    orderBy: { order: 'asc' },
  });

  if (firstSubTask) {
    // Step has pending sub-tasks → step IN_PROGRESS, first sub-task NOTIFIED
    await prisma.workflowStep.update({
      where: { id: step.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
    await prisma.workflowSubTask.update({
      where: { id: firstSubTask.id },
      data: { status: 'NOTIFIED' },
    });
    broadcastEvent('step_started', { jobId, stepId: step.id, stepNumber: step.stepNumber });
    if (firstSubTask.assignedUserId) {
      return await sendSubTaskNotification(firstSubTask.id, { simulate: options.simulateOutbound });
    }
    return null;
  }

  // No sub-tasks → classic behaviour: step NOTIFIED, step worker notified
  await prisma.workflowStep.update({
    where: { id: step.id },
    data: { status: 'NOTIFIED', startedAt: new Date() },
  });
  broadcastEvent('step_started', { jobId, stepId: step.id, stepNumber: step.stepNumber });
  if (step.assignedUserId) {
    return await sendStepNotification(step.id, { simulate: options.simulateOutbound });
  }
  return null;
}

// ─── advanceWorkflow ──────────────────────────────────────────────────────────
export async function advanceWorkflow(
  jobId: string,
  completedStepId: string,
  options: WorkflowDispatchOptions = {},
): Promise<DeliveryResult | null> {
  const completedStep = await prisma.workflowStep.findUnique({
    where: { id: completedStepId },
    include: { job: true },
  });

  if (!completedStep) return null;

  await prisma.workflowStep.update({
    where: { id: completedStepId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      jobId,
      stepId: completedStepId,
      eventType: 'STEP_COMPLETED',
      description: `Step "${completedStep.name}" completed`,
    },
  });

  const completedCount = await prisma.workflowStep.count({
    where: { jobId, status: 'COMPLETED' },
  });

  await prisma.job.update({
    where: { id: jobId },
    data: { completedSteps: completedCount },
  });

  broadcastEvent('step_completed', { jobId, stepId: completedStepId, completedCount });

  const nextStep = await prisma.workflowStep.findFirst({
    where: { jobId, status: 'WAITING' },
    orderBy: { stepNumber: 'asc' },
  });

  if (!nextStep) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await prisma.auditLog.create({
      data: {
        jobId,
        eventType: 'JOB_COMPLETED',
        description: `Job #${completedStep.job.jobNumber} completed all steps`,
      },
    });
    broadcastEvent('job_completed', { jobId });
    return null;
  }

  return await startStep(nextStep, jobId, options);
}

// ─── advanceSubTask ───────────────────────────────────────────────────────────
// Called when a sub-task worker replies DONE.
// Completes the sub-task, notifies the next sub-task, or (if all done)
// completes the parent step and advances the main workflow.
export async function advanceSubTask(
  jobId: string,
  subTaskId: string,
  options: WorkflowDispatchOptions = {},
): Promise<DeliveryResult | null> {
  const subTask = await prisma.workflowSubTask.findUnique({
    where: { id: subTaskId },
    include: { step: { include: { job: true } } },
  });
  if (!subTask) return null;

  await prisma.workflowSubTask.update({
    where: { id: subTaskId },
    data: { status: 'COMPLETED', isCompleted: true },
  });

  await prisma.auditLog.create({
    data: {
      jobId,
      stepId: subTask.stepId,
      eventType: 'STEP_COMPLETED',
      description: `Sub-task "${subTask.title}" completed (Step "${subTask.step.name}")`,
    },
  });

  broadcastEvent('subtask_completed', { jobId, stepId: subTask.stepId, subTaskId });

  const nextSubTask = await prisma.workflowSubTask.findFirst({
    where: { stepId: subTask.stepId, status: 'WAITING' },
    orderBy: { order: 'asc' },
  });

  if (nextSubTask) {
    await prisma.workflowSubTask.update({
      where: { id: nextSubTask.id },
      data: { status: 'NOTIFIED' },
    });
    broadcastEvent('subtask_started', { jobId, stepId: subTask.stepId, subTaskId: nextSubTask.id });
    if (nextSubTask.assignedUserId) {
      return await sendSubTaskNotification(nextSubTask.id, { simulate: options.simulateOutbound });
    }
    return null;
  }

  // All sub-tasks done → complete the parent step and advance
  return await advanceWorkflow(jobId, subTask.stepId, options);
}

// ─── startWorkflow ────────────────────────────────────────────────────────────
export async function startWorkflow(jobId: string, options: WorkflowDispatchOptions = {}): Promise<WorkflowStartResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { workflowSteps: { orderBy: { stepNumber: 'asc' } } },
  });

  if (!job) throw new Error('Job not found');
  if (job.workflowSteps.length === 0) throw new Error('No steps defined for this job');

  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'IN_PROGRESS' },
  });

  const firstStep = job.workflowSteps[0];

  await prisma.auditLog.create({
    data: {
      jobId,
      stepId: firstStep.id,
      eventType: 'WORKFLOW_STARTED',
      description: `Workflow started for job #${job.jobNumber}`,
    },
  });

  broadcastEvent('workflow_started', { jobId, firstStepId: firstStep.id });

  const notification = await startStep(firstStep, jobId, options);
  return { firstStepId: firstStep.id, notification };
}

