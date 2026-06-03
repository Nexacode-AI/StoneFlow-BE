-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "projectLevelId" TEXT;

-- CreateTable
CREATE TABLE "ProjectLevel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectLevel_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ProjectLevel" ADD CONSTRAINT "ProjectLevel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectLevelId_fkey" FOREIGN KEY ("projectLevelId") REFERENCES "ProjectLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
