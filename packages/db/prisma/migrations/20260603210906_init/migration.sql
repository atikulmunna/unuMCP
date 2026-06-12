-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'SPEC_UPLOADED', 'SPEC_VALIDATED', 'ENDPOINTS_ANALYZED', 'TOOLS_PROPOSED', 'AWAITING_USER_APPROVAL', 'TOOLS_APPROVED', 'CODE_GENERATING', 'TEST_GENERATING', 'TEST_RUNNING', 'REPAIRING_FAILED_CODE', 'TESTS_PASSED', 'PACKAGING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'SPEC_INVALID', 'GENERATION_FAILED', 'TESTS_FAILED', 'SANDBOX_FAILED', 'PACKAGE_FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('valid', 'invalid');

-- CreateEnum
CREATE TYPE "CreatedBy" AS ENUM ('agent', 'user');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('source_file', 'test_file', 'archive', 'readme');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('running', 'failed', 'passed', 'passed_with_warnings', 'cancelled');

-- CreateEnum
CREATE TYPE "Actor" AS ENUM ('user', 'agent', 'system');

-- CreateEnum
CREATE TYPE "MappingKind" AS ENUM ('one_to_one', 'merged', 'split');

-- CreateEnum
CREATE TYPE "RepairOutcome" AS ENUM ('passed', 'failed', 'no_change');

-- CreateEnum
CREATE TYPE "TestStatus" AS ENUM ('passed', 'failed', 'skipped', 'errored');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceType" TEXT NOT NULL DEFAULT 'openapi_upload',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiSpec" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "originalFileUrl" TEXT NOT NULL,
    "parsedJson" JSONB,
    "openapiVersion" TEXT,
    "title" TEXT,
    "version" TEXT,
    "baseUrl" TEXT,
    "validationStatus" "ValidationStatus" NOT NULL DEFAULT 'invalid',
    "validationErrors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Endpoint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "operationId" TEXT,
    "summary" TEXT,
    "description" TEXT,
    "tag" TEXT,
    "requestSchema" JSONB,
    "responseSchema" JSONB,
    "authRequired" BOOLEAN NOT NULL DEFAULT false,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "operationType" TEXT NOT NULL DEFAULT 'unknown',
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'low',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCandidate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "outputSchema" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'low',
    "createdBy" "CreatedBy" NOT NULL DEFAULT 'agent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolEndpoint" (
    "id" TEXT NOT NULL,
    "toolCandidateId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "mappingKind" "MappingKind" NOT NULL DEFAULT 'one_to_one',
    "note" TEXT,

    CONSTRAINT "ToolEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedArtifact" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "artifactType" "ArtifactType" NOT NULL,
    "path" TEXT NOT NULL,
    "contentUrl" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "repairAttempts" INTEGER NOT NULL DEFAULT 0,
    "llmModelId" TEXT,
    "promptVersion" TEXT,
    "mcpSdkVersion" TEXT,
    "mcpProtocolVersion" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(10,4),

    CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairAttempt" (
    "id" TEXT NOT NULL,
    "generationRunId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "failureSummary" TEXT NOT NULL,
    "diff" TEXT NOT NULL,
    "outcome" "RepairOutcome" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepairAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestResult" (
    "id" TEXT NOT NULL,
    "generationRunId" TEXT NOT NULL,
    "suite" TEXT NOT NULL,
    "status" "TestStatus" NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "failingTestCount" INTEGER NOT NULL DEFAULT 0,
    "totalTestCount" INTEGER NOT NULL DEFAULT 0,
    "logExcerpt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "eventType" TEXT NOT NULL,
    "actor" "Actor" NOT NULL DEFAULT 'system',
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE INDEX "ApiSpec_projectId_idx" ON "ApiSpec"("projectId");

-- CreateIndex
CREATE INDEX "Endpoint_projectId_idx" ON "Endpoint"("projectId");

-- CreateIndex
CREATE INDEX "ToolCandidate_projectId_idx" ON "ToolCandidate"("projectId");

-- CreateIndex
CREATE INDEX "ToolEndpoint_endpointId_idx" ON "ToolEndpoint"("endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolEndpoint_toolCandidateId_endpointId_key" ON "ToolEndpoint"("toolCandidateId", "endpointId");

-- CreateIndex
CREATE INDEX "GeneratedArtifact_projectId_idx" ON "GeneratedArtifact"("projectId");

-- CreateIndex
CREATE INDEX "GenerationRun_projectId_idx" ON "GenerationRun"("projectId");

-- CreateIndex
CREATE INDEX "RepairAttempt_generationRunId_idx" ON "RepairAttempt"("generationRunId");

-- CreateIndex
CREATE INDEX "TestResult_generationRunId_idx" ON "TestResult"("generationRunId");

-- CreateIndex
CREATE INDEX "AuditEvent_projectId_idx" ON "AuditEvent"("projectId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiSpec" ADD CONSTRAINT "ApiSpec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCandidate" ADD CONSTRAINT "ToolCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolEndpoint" ADD CONSTRAINT "ToolEndpoint_toolCandidateId_fkey" FOREIGN KEY ("toolCandidateId") REFERENCES "ToolCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolEndpoint" ADD CONSTRAINT "ToolEndpoint_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedArtifact" ADD CONSTRAINT "GeneratedArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairAttempt" ADD CONSTRAINT "RepairAttempt_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResult" ADD CONSTRAINT "TestResult_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
