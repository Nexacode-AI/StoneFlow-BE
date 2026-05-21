import prisma from '../lib/prisma';
import { broadcastEvent } from '../lib/websocket';
import { sendStepNotification, DeliveryResult } from './whatsapp';

type WorkflowDispatchOptions = {
  simulateOutbound?: boolean;
};

export type WorkflowStartResult = {
  firstStepId: string;
  notification: DeliveryResult | null;
};

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

  await prisma.workflowStep.update({
    where: { id: nextStep.id },
    data: { status: 'NOTIFIED', startedAt: new Date() },
  });

  broadcastEvent('step_started', { jobId, stepId: nextStep.id, stepNumber: nextStep.stepNumber });

  if (nextStep.assignedUserId) {
    return await sendStepNotification(nextStep.id, { simulate: options.simulateOutbound });
  }
  return null;
}

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

  await prisma.workflowStep.update({
    where: { id: firstStep.id },
    data: { status: 'NOTIFIED', startedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      jobId,
      stepId: firstStep.id,
      eventType: 'WORKFLOW_STARTED',
      description: `Workflow started for job #${job.jobNumber}`,
    },
  });

  broadcastEvent('workflow_started', { jobId, firstStepId: firstStep.id });

  let notification: DeliveryResult | null = null;
  if (firstStep.assignedUserId) {
    notification = await sendStepNotification(firstStep.id, { simulate: options.simulateOutbound });
  }
  return { firstStepId: firstStep.id, notification };
}
