import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { dereferenceSpec, detectAuth, extractEndpoints } from "@unumcp/openapi";
import type { DetectedAuth, ExtractedEndpoint } from "@unumcp/openapi";
import { generateProject } from "@unumcp/codegen";
import type { GeneratedFile, RiskLevel } from "@unumcp/codegen";
import { scanGeneratedProject, summarizeScan, redactSecrets } from "@unumcp/security-scan";
import { ArtifactType, ProjectStatus } from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { LlmService } from "../llm/llm.service";
import { estimateCostUsd } from "../llm/llm-pricing";
import { ApprovedTool, buildGenerateOptions, toServerName } from "./build-generate-options";
import { createZip } from "./zip";
import { computeWarnings, renderWarningsMarkdown } from "../completion/warnings";

const MCP_SDK_VERSION = "1.29.0";

@Injectable()
export class GenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Generate a complete MCP server project from the project's approved tools
   * (P3-9). Records a `GenerationRun`, persists each file as a
   * `GeneratedArtifact` (with content hash for reproducibility), and advances
   * the project state. Generation is deterministic (§9.7.0).
   */
  async generate(projectId: string, userId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });

    // No-duplicate-artifacts guard (NFR-006): refuse a second concurrent run for
    // the same project. Enforced at the domain layer so it holds whether invoked
    // inline, by a queue worker, or by a retry — independent of the queue.
    const active = await this.prisma.generationRun.findFirst({
      where: { projectId, status: "running" },
    });
    if (active) {
      throw new ConflictException("A generation run is already in progress for this project.");
    }

    const tools = await this.prisma.toolCandidate.findMany({
      where: { projectId, approved: true },
      include: { endpoints: { include: { endpoint: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (tools.length === 0) {
      throw new BadRequestException("Approve at least one tool before generating.");
    }

    const spec = await this.prisma.apiSpec.findFirst({
      where: { projectId, validationStatus: "valid" },
      orderBy: { createdAt: "desc" },
    });
    if (!spec?.parsedJson) {
      throw new BadRequestException("No validated spec found for this project.");
    }

    const deref = await dereferenceSpec(spec.parsedJson as object);
    const endpointsByKey = new Map<string, ExtractedEndpoint>(
      extractEndpoints(deref).map((e) => [`${e.method} ${e.path}`, e]),
    );
    const auth: DetectedAuth =
      (spec.detectedAuth as unknown as DetectedAuth | null) ?? detectAuth(deref);

    const run = await this.prisma.generationRun.create({
      data: { projectId, status: "running", mcpSdkVersion: MCP_SDK_VERSION },
    });
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: "CODE_GENERATING" },
    });

    try {
      const approved: ApprovedTool[] = tools.map((t) => {
        const link = t.endpoints[0]?.endpoint;
        const endpoint = link ? endpointsByKey.get(`${link.method} ${link.path}`) : undefined;
        if (!endpoint) {
          throw new BadRequestException(`No endpoint mapping for tool "${t.name}".`);
        }
        return {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as object,
          riskLevel: t.riskLevel as RiskLevel,
          endpoint,
        };
      });

      const baseUrl = spec.baseUrl ?? "https://api.example.com";
      const files = generateProject(
        buildGenerateOptions({
          serverName: toServerName(project.name),
          displayName: project.name,
          baseUrl,
          auth,
          tools: approved,
        }),
      );

      // Static security gate before anything is persisted or packaged (P6-3,
      // §16.3). Although generation is deterministic, the base URL and tool
      // names/descriptions come from an untrusted spec — refuse to ship code
      // that smells of injected secrets, exfiltration hosts, or eval/shell.
      const scan = scanGeneratedProject(files, { allowedHosts: [hostOf(baseUrl)] });
      if (!scan.passed) {
        const high = scan.findings.filter((f) => f.severity === "high");
        await this.prisma.auditEvent.create({
          data: {
            projectId,
            userId,
            eventType: "security_scan_failed",
            actor: "agent",
            summary: `Generated code failed the security scan: ${summarizeScan(scan)}`,
            metadata: JSON.parse(JSON.stringify({ findings: high.slice(0, 20) })),
          },
        });
        const detail = high
          .slice(0, 5)
          .map((f) => `${f.path}:${f.line} ${f.rule} — ${f.message}`)
          .join("; ");
        throw new BadRequestException(
          `Generated code failed the security scan (${high.length} high-severity finding(s)): ${detail}`,
        );
      }

      await this.persistArtifacts(projectId, run.id, files);

      // Attribute the LLM cost of proposing this project's tools to the run
      // (NFR-007b, P6-7). Tokens come from the FR-031 `llm_tool_call` traces
      // recorded during `tools/propose`; repair passes add to these later.
      const proposal = await this.sumProposalUsage(projectId, run.startedAt);
      const model = this.llm.model;

      await this.prisma.$transaction([
        this.prisma.generationRun.update({
          where: { id: run.id },
          data: {
            status: "passed",
            completedAt: new Date(),
            inputTokens: proposal.inputTokens,
            outputTokens: proposal.outputTokens,
            estimatedCostUsd: estimateCostUsd(model, proposal.inputTokens, proposal.outputTokens),
            llmModelId: proposal.inputTokens > 0 ? model : null,
          },
        }),
        // Code (and its tests) are generated; the next stage is the test/sandbox phase.
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: "TEST_GENERATING" },
        }),
        this.prisma.auditEvent.create({
          data: {
            projectId,
            userId,
            eventType: "code_generated",
            actor: "agent",
            summary: `Generated ${files.length} file(s) for ${approved.length} tool(s)`,
          },
        }),
      ]);

      return { runId: run.id, status: "passed", fileCount: files.length };
    } catch (err) {
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorMessage: redactSecrets(err instanceof Error ? err.message : String(err)),
        },
      });
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: "GENERATION_FAILED" },
      });
      throw err;
    }
  }

  /** Latest generation run with its artifacts (§14.5). */
  async getLatest(projectId: string) {
    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    if (!run) return null;
    const artifacts = await this.prisma.generatedArtifact.findMany({
      where: { projectId },
      orderBy: { path: "asc" },
      select: { id: true, path: true, artifactType: true, contentHash: true },
    });
    return { run, artifacts };
  }

  /**
   * Read one generated artifact's content for in-browser preview (P4-9, §15.5).
   * Scoped by `projectId` (on top of the controller's ownership guard) so an
   * artifact id from another project can't be read. Generated sources never
   * contain secrets (only `.env.example` placeholders), so the content is
   * returned verbatim.
   */
  async getArtifactContent(projectId: string, artifactId: string) {
    const artifact = await this.prisma.generatedArtifact.findFirst({
      where: { id: artifactId, projectId },
    });
    if (!artifact?.contentUrl) {
      throw new NotFoundException("Artifact not found.");
    }
    const content = await this.storage.read(artifact.contentUrl);
    return { path: artifact.path, artifactType: artifact.artifactType, content };
  }

  /**
   * Repair history for the latest run (P4-6/P4-9, §13.6b/§15.5): each attempt's
   * diff, failure summary, and outcome, so the dashboard can show what the
   * repair loop changed. Empty when nothing has been repaired.
   */
  async getRepairs(projectId: string) {
    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    if (!run) return [];
    return this.prisma.repairAttempt.findMany({
      where: { generationRunId: run.id },
      orderBy: { attemptNumber: "asc" },
      select: {
        attemptNumber: true,
        failureSummary: true,
        diff: true,
        outcome: true,
        createdAt: true,
      },
    });
  }

  /**
   * Package the latest generated artifacts into a downloadable ZIP (P5-2/3,
   * FR-027). Reads each stored file and zips it deterministically. The archive
   * carries only generated sources (incl. `.env.example` with placeholders) —
   * never a populated `.env` — so no secrets leave the platform.
   */
  async downloadZip(projectId: string): Promise<{ filename: string; buffer: Buffer }> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const artifacts = await this.prisma.generatedArtifact.findMany({
      where: { projectId, contentUrl: { not: null } },
      orderBy: { path: "asc" },
    });
    if (artifacts.length === 0) {
      throw new NotFoundException("No generated artifacts to download. Generate the server first.");
    }

    const files = await Promise.all(
      artifacts.map(async (a) => ({
        path: a.path,
        content: await this.storage.read(a.contentUrl as string),
      })),
    );

    // Partial output from a warned build embeds the warnings (P5-4, §26.4).
    if (project.status === ProjectStatus.COMPLETED_WITH_WARNINGS) {
      const warnings = await this.gatherWarnings(projectId);
      if (warnings.length > 0) {
        files.push({ path: "WARNINGS.md", content: renderWarningsMarkdown(warnings) });
      }
    }

    const buffer = await createZip(files);
    return { filename: `${toServerName(project.name)}.zip`, buffer };
  }

  /** Recompute the deterministic completion warnings for a project. */
  private async gatherWarnings(projectId: string): Promise<string[]> {
    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    const latestTest = run
      ? await this.prisma.testResult.findFirst({
          where: { generationRunId: run.id },
          orderBy: { createdAt: "desc" },
        })
      : null;
    const spec = await this.prisma.apiSpec.findFirst({
      where: { projectId, validationStatus: "valid" },
      orderBy: { createdAt: "desc" },
    });
    const auth = spec?.detectedAuth as DetectedAuth | null;
    return computeWarnings({
      authNeedsUserConfig: auth?.needsUserConfig ?? false,
      totalTestCount: latestTest?.totalTestCount ?? 0,
      failingTestCount: latestTest?.failingTestCount ?? 0,
    });
  }

  /**
   * Sum the LLM tokens spent proposing this project's tools, attributed to the
   * current run: the `propose_*` traces created since the previous run started
   * (or all of them for the first run). This maps one proposal batch to the one
   * generation it fed, and never double-counts across re-generations.
   */
  private async sumProposalUsage(
    projectId: string,
    currentRunStartedAt: Date,
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    const prevRun = await this.prisma.generationRun.findFirst({
      where: { projectId, startedAt: { lt: currentRunStartedAt } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    const traces = await this.prisma.auditEvent.findMany({
      where: {
        projectId,
        eventType: "llm_tool_call",
        ...(prevRun ? { createdAt: { gt: prevRun.startedAt } } : {}),
      },
      select: { metadata: true },
    });
    let inputTokens = 0;
    let outputTokens = 0;
    for (const t of traces) {
      const m = t.metadata as { toolName?: unknown; inputTokens?: unknown; outputTokens?: unknown } | null;
      if (typeof m?.toolName === "string" && m.toolName.startsWith("propose")) {
        inputTokens += Number(m.inputTokens ?? 0);
        outputTokens += Number(m.outputTokens ?? 0);
      }
    }
    return { inputTokens, outputTokens };
  }

  private async persistArtifacts(projectId: string, runId: string, files: GeneratedFile[]) {
    // Replace any prior artifacts so re-generation is idempotent.
    await this.prisma.generatedArtifact.deleteMany({ where: { projectId } });
    for (const file of files) {
      const contentHash = createHash("sha256").update(file.content).digest("hex");
      const contentUrl = await this.storage.save(
        `${projectId}/generated/${runId}/${file.path}`,
        file.content,
      );
      await this.prisma.generatedArtifact.create({
        data: {
          projectId,
          artifactType: classifyArtifact(file.path),
          path: file.path,
          contentUrl,
          contentHash,
        },
      });
    }
  }
}

/** Hostname (no port) of a base URL; "" if it can't be parsed. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function classifyArtifact(path: string): ArtifactType {
  if (path === "README.md") return ArtifactType.readme;
  if (path.startsWith("tests/") || path.endsWith(".test.ts")) return ArtifactType.test_file;
  return ArtifactType.source_file;
}
