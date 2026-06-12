import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { dereferenceSpec, extractEndpoints, toCycleSafe } from "@unumcp/openapi";
import type { ExtractedEndpoint } from "@unumcp/openapi";
import { proposeTools } from "@unumcp/analysis";
import type { ToolDraft } from "@unumcp/analysis";
import { Prisma } from "@unumcp/db";
import { detectPromptInjection } from "@unumcp/security-scan";
import { PrismaService } from "../prisma/prisma.service";
import { LlmService } from "../llm/llm.service";
import { mapWithConcurrency } from "../common/concurrency";
import type { UpdateToolInput } from "./schemas";

const MUTATING = new Set(["create", "update", "delete", "upload"]);

@Injectable()
export class ToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Propose tools from the project's validated spec (P2-3). Names, risk, and the
   * input schema stay deterministic (`@unumcp/analysis`); the human-facing
   * description is LLM-authored when available (P2-5, FR-013) and falls back to
   * the deterministic draft description whenever the LLM is off or errors.
   */
  async propose(projectId: string) {
    const spec = await this.prisma.apiSpec.findFirst({
      where: { projectId, validationStatus: "valid" },
      orderBy: { createdAt: "desc" },
    });
    if (!spec?.parsedJson) {
      throw new BadRequestException("Upload and validate a spec before proposing tools.");
    }

    const deref = await dereferenceSpec(spec.parsedJson as object);
    const endpoints = extractEndpoints(deref);
    const drafts = proposeTools(endpoints);

    // Resolve descriptions BEFORE opening the transaction so slow LLM calls never
    // hold a DB transaction open. Bounded concurrency keeps the fan-out polite;
    // batching/caching is the P2-6 refinement, background execution is P6-6.
    const descriptions = this.llm.enabled
      ? await mapWithConcurrency(drafts, 5, (d, i) => this.describe(d, endpoints[i]))
      : drafts.map((d) => d.description);

    // Flag (don't block) untrusted spec text that looks like a prompt-injection
    // attempt (P6-2, §16.2 "flag suspicious descriptions"). The LLM is already
    // told to ignore instructions in the data; this surfaces it in the audit trail.
    const flagged = drafts.flatMap((d, i) => {
      const ep = endpoints[i];
      const result = detectPromptInjection(`${ep?.summary ?? ""}\n${ep?.description ?? ""}`);
      return result.suspicious
        ? [{ tool: d.name, categories: [...new Set(result.findings.map((f) => f.category))] }]
        : [];
    });

    const dbEndpoints = await this.prisma.endpoint.findMany({ where: { projectId } });
    const endpointIdByKey = new Map(dbEndpoints.map((e) => [`${e.method} ${e.path}`, e.id]));

    await this.prisma.$transaction(async (tx) => {
      await tx.toolCandidate.deleteMany({ where: { projectId } });
      for (const [i, d] of drafts.entries()) {
        const tool = await tx.toolCandidate.create({
          data: {
            projectId,
            name: d.name,
            description: descriptions[i] ?? d.description,
            inputSchema: toCycleSafe(d.inputSchema) as unknown as Prisma.InputJsonValue,
            enabled: d.enabledByDefault,
            riskLevel: d.riskLevel,
            createdBy: "agent",
          },
        });
        const endpointId = endpointIdByKey.get(`${d.method} ${d.path}`);
        if (endpointId) {
          await tx.toolEndpoint.create({
            data: { toolCandidateId: tool.id, endpointId, mappingKind: "one_to_one" },
          });
        }
      }
      await tx.project.update({ where: { id: projectId }, data: { status: "TOOLS_PROPOSED" } });

      if (flagged.length > 0) {
        await tx.auditEvent.create({
          data: {
            projectId,
            eventType: "prompt_injection_flagged",
            actor: "system",
            summary: `Flagged ${flagged.length} endpoint description(s) for possible prompt injection: ${flagged.map((f) => f.tool).join(", ")}`,
            // Store the matched categories only — never the attacker's raw payload.
            metadata: { flagged } as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });

    return this.list(projectId);
  }

  /** Build the LLM proposal input for one draft and request a description. */
  private describe(draft: ToolDraft, endpoint?: ExtractedEndpoint): Promise<string | null> {
    const paramNames = (endpoint?.parameters ?? [])
      .filter((p) => p.in === "path" || p.in === "query")
      .map((p) => p.name);
    return this.llm.describeTool({
      toolName: draft.name,
      method: draft.method,
      path: draft.path,
      summary: endpoint?.summary,
      specDescription: endpoint?.description,
      paramNames,
      mutates: MUTATING.has(draft.operationType),
      riskLevel: draft.riskLevel,
    });
  }

  /** List candidates with endpoint mapping + risk for the review UI (P2-10, NFR-009). */
  list(projectId: string) {
    return this.prisma.toolCandidate.findMany({
      where: { projectId },
      include: {
        endpoints: {
          include: {
            endpoint: {
              select: { method: true, path: true, operationId: true },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async updateTool(projectId: string, toolId: string, data: UpdateToolInput) {
    const updated = await this.prisma.toolCandidate.updateMany({
      where: { id: toolId, projectId },
      data,
    });
    if (updated.count === 0) throw new NotFoundException("Tool not found");
    return this.prisma.toolCandidate.findUniqueOrThrow({ where: { id: toolId } });
  }

  /** Approve the enabled tools as the final plan (P2-9, FR-015). */
  async approve(projectId: string, userId: string) {
    const tools = await this.prisma.toolCandidate.findMany({ where: { projectId } });
    if (tools.length === 0) throw new BadRequestException("No tools to approve. Propose tools first.");
    const enabledCount = tools.filter((t) => t.enabled).length;
    if (enabledCount === 0) {
      throw new BadRequestException("Enable at least one tool before approving.");
    }

    await this.prisma.$transaction([
      this.prisma.toolCandidate.updateMany({
        where: { projectId, enabled: true },
        data: {
          approved: true,
          approvedByUserId: userId,
          approvedAt: new Date(),
          planVersion: { increment: 1 },
        },
      }),
      this.prisma.toolCandidate.updateMany({
        where: { projectId, enabled: false },
        data: { approved: false },
      }),
      this.prisma.project.update({ where: { id: projectId }, data: { status: "TOOLS_APPROVED" } }),
      this.prisma.auditEvent.create({
        data: {
          projectId,
          userId,
          eventType: "tools_approved",
          actor: "user",
          summary: `Approved ${enabledCount} tool(s)`,
        },
      }),
    ]);

    return { approvedCount: enabledCount };
  }
}
