-- CreateEnum
CREATE TYPE "UsabilityStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "UsabilityOutcome" AS ENUM ('correct', 'wrong_tool', 'bad_args', 'no_answer');

-- CreateEnum
CREATE TYPE "UsabilityFixStatus" AS ENUM ('proposed', 'accepted', 'rejected', 'stale');

-- CreateTable
CREATE TABLE "UsabilityRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "UsabilityStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "note" TEXT,
    "llmModelId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "taskCount" INTEGER NOT NULL DEFAULT 0,
    "answeredCount" INTEGER NOT NULL DEFAULT 0,
    "baselineCorrect" INTEGER NOT NULL DEFAULT 0,
    "fixedCorrect" INTEGER,

    CONSTRAINT "UsabilityRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsabilityTask" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolId" TEXT,
    "toolName" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "expectedArgs" JSONB NOT NULL,
    "candidateNames" JSONB NOT NULL,
    "chosenTool" TEXT,
    "chosenArgs" JSONB,
    "outcome" "UsabilityOutcome" NOT NULL,
    "reason" TEXT,

    CONSTRAINT "UsabilityTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsabilityFix" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolId" TEXT,
    "toolName" TEXT NOT NULL,
    "beforeName" TEXT NOT NULL,
    "afterName" TEXT,
    "beforeDescription" TEXT NOT NULL,
    "afterDescription" TEXT NOT NULL,
    "missesFixed" INTEGER NOT NULL,
    "pairedWith" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "UsabilityFixStatus" NOT NULL DEFAULT 'proposed',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,

    CONSTRAINT "UsabilityFix_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsabilityRun_projectId_idx" ON "UsabilityRun"("projectId");

-- CreateIndex
CREATE INDEX "UsabilityTask_runId_idx" ON "UsabilityTask"("runId");

-- CreateIndex
CREATE INDEX "UsabilityFix_runId_idx" ON "UsabilityFix"("runId");

-- AddForeignKey
ALTER TABLE "UsabilityRun" ADD CONSTRAINT "UsabilityRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsabilityTask" ADD CONSTRAINT "UsabilityTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "UsabilityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsabilityTask" ADD CONSTRAINT "UsabilityTask_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ToolCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsabilityFix" ADD CONSTRAINT "UsabilityFix_runId_fkey" FOREIGN KEY ("runId") REFERENCES "UsabilityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsabilityFix" ADD CONSTRAINT "UsabilityFix_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ToolCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

