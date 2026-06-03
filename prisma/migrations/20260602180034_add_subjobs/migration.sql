-- CreateEnum
CREATE TYPE "SubTaskStatus" AS ENUM ('WAITING', 'NOTIFIED', 'COMPLETED');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "level" TEXT,
ADD COLUMN     "parentJobId" TEXT,
ADD COLUMN     "startDate" TIMESTAMP(3),
ADD COLUMN     "unitNumber" TEXT;

-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN     "autoStartOnDate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WorkflowSubTask" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedUserId" TEXT,
    "dueAt" TIMESTAMP(3),
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "status" "SubTaskStatus" NOT NULL DEFAULT 'WAITING',
    "order" INTEGER NOT NULL DEFAULT 0,
    "issueText" TEXT,
    "durationMinutes" INTEGER,
    "timerStartedAt" TIMESTAMP(3),
    "timerAlertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowSubTask_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_parentJobId_fkey" FOREIGN KEY ("parentJobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSubTask" ADD CONSTRAINT "WorkflowSubTask_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSubTask" ADD CONSTRAINT "WorkflowSubTask_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
