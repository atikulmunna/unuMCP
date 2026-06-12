import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

// Integration test — requires the dev Postgres (docker compose up postgres).
const prisma = new PrismaClient();
const createdUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdUserIds) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("db schema (integration, requires Postgres)", () => {
  it("creates and reads back a full project graph", async () => {
    const user = await prisma.user.create({
      data: { email: `graph-${Date.now()}@example.com`, name: "Test" },
    });
    createdUserIds.push(user.id);

    const project = await prisma.project.create({
      data: { userId: user.id, name: "Demo" },
    });
    expect(project.status).toBe("DRAFT");
    expect(project.sourceType).toBe("openapi_upload");

    const endpoint = await prisma.endpoint.create({
      data: { projectId: project.id, method: "post", path: "/repos/{owner}/{repo}/issues" },
    });
    const tool = await prisma.toolCandidate.create({
      data: {
        projectId: project.id,
        name: "create_issue",
        description: "Create an issue.",
        inputSchema: { type: "object", properties: { owner: { type: "string" } } },
      },
    });
    await prisma.toolEndpoint.create({
      data: { toolCandidateId: tool.id, endpointId: endpoint.id, mappingKind: "one_to_one" },
    });

    const run = await prisma.generationRun.create({
      data: { projectId: project.id, mcpSdkVersion: "1.29.0", promptVersion: "v1" },
    });
    await prisma.repairAttempt.create({
      data: {
        generationRunId: run.id,
        attemptNumber: 1,
        failureSummary: "type error",
        diff: "- a\n+ b",
        outcome: "passed",
      },
    });
    await prisma.testResult.create({
      data: {
        generationRunId: run.id,
        suite: "createIssue.test.ts",
        status: "passed",
        durationMs: 12,
        totalTestCount: 4,
      },
    });
    await prisma.auditEvent.create({
      data: { projectId: project.id, eventType: "spec_uploaded", actor: "user", summary: "uploaded" },
    });

    const loaded = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        endpoints: true,
        tools: { include: { endpoints: true } },
        runs: { include: { repairs: true, testResults: true } },
        auditEvents: true,
      },
    });

    expect(loaded.endpoints).toHaveLength(1);
    expect(loaded.tools[0]?.endpoints[0]?.endpointId).toBe(endpoint.id);
    expect(loaded.runs[0]?.mcpSdkVersion).toBe("1.29.0");
    expect(loaded.runs[0]?.repairs).toHaveLength(1);
    expect(loaded.runs[0]?.testResults[0]?.status).toBe("passed");
    expect(loaded.auditEvents[0]?.eventType).toBe("spec_uploaded");
  });

  it("cascades deletes from user through the whole graph", async () => {
    const user = await prisma.user.create({
      data: { email: `cascade-${Date.now()}@example.com` },
    });
    const project = await prisma.project.create({ data: { userId: user.id, name: "C" } });
    await prisma.endpoint.create({ data: { projectId: project.id, method: "get", path: "/y" } });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await prisma.endpoint.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("enforces unique tool↔endpoint links", async () => {
    const user = await prisma.user.create({ data: { email: `uniq-${Date.now()}@example.com` } });
    createdUserIds.push(user.id);
    const project = await prisma.project.create({ data: { userId: user.id, name: "U" } });
    const endpoint = await prisma.endpoint.create({
      data: { projectId: project.id, method: "get", path: "/z" },
    });
    const tool = await prisma.toolCandidate.create({
      data: { projectId: project.id, name: "get_z", description: "d", inputSchema: {} },
    });
    await prisma.toolEndpoint.create({ data: { toolCandidateId: tool.id, endpointId: endpoint.id } });
    await expect(
      prisma.toolEndpoint.create({ data: { toolCandidateId: tool.id, endpointId: endpoint.id } }),
    ).rejects.toThrow();
  });
});
