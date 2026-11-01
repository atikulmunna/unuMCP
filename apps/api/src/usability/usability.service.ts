import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { UsabilityTool } from "@unumcp/usability";
import { Prisma } from "@unumcp/db";
import { detectPromptInjection, redactSecrets } from "@unumcp/security-scan";
import { PrismaService } from "../prisma/prisma.service";
import { LlmService } from "../llm/llm.service";
import { estimateCostUsd } from "../llm/llm-pricing";
import { ToolsService } from "../tools/tools.service";
import type { UsabilityConfig } from "./usability.config";
import { runUsabilityCheck, type CheckResult, type Meter } from "./usability-check";
import { REVIEW_STATUSES } from "../tools/review";


export interface CheckSummary {
  runId: string;
  status: "completed" | "failed";
  taskCount: number;
  answeredCount: number;
  baselineCorrect: number;
  fixedCorrect: number | null;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * The agent usability check (on demand, from the Tool plan stage): measures
 * whether an agent picks the right tool with the right arguments, and offers
 * fixes for the misses for the user to accept or reject. Nothing generated is
 * executed; the model only sees tool metadata.
 */
@Injectable()
export class UsabilityService {
  private readonly logger = new Logger("UsabilityService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tools: ToolsService,
    private readonly config: UsabilityConfig,
  ) {}

  /** Whether a check can run at all: it needs the LLM. */
  get llmEnabled(): boolean {
    return this.llm.enabled;
  }

  /** Refuse a check that can't or mustn't start; called before running or enqueueing one. */
  async assertCanStart(projectId: string): Promise<void> {
    if (!this.llm.enabled) {
      throw new BadRequestException(
        "The usability check needs the LLM: set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY.",
      );
    }
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true } });
    if (!REVIEW_STATUSES.includes(project.status)) {
      throw new ConflictException("The usability check runs while the tool plan is under review.");
    }
    const enabled = await this.prisma.toolCandidate.count({ where: { projectId, enabled: true } });
    if (enabled < 2) {
      throw new BadRequestException("Enable at least two tools: with one, there is nothing to confuse it with.");
    }
    const running = await this.prisma.usabilityRun.findFirst({ where: { projectId, status: "running" } });
    if (running) throw new ConflictException("A usability check is already running for this project.");
  }

  /** Run one check and store its result; a failure is stored on the run, not thrown. */
  async runCheck(projectId: string): Promise<CheckSummary> {
    const { tools, idByName } = await this.loadTools(projectId);
    const run = await this.prisma.usabilityRun.create({ data: { projectId, llmModelId: this.llm.model } });
    const meter: Meter = { calls: 0, inputTokens: 0, outputTokens: 0, model: null };
    const ctx = { projectId };
    try {
      const result = await runUsabilityCheck(
        tools,
        {
          writeTasks: (views) => this.llm.writeUsabilityTasks(views, ctx),
          chooseTool: (request, candidates) => this.llm.chooseUsabilityTool(request, candidates, ctx),
          proposeFixes: (requests) => this.llm.proposeUsabilityFixes(requests, ctx),
        },
        { ...this.config, isSafeText: (text) => !detectPromptInjection(text).suspicious },
        meter,
      );
      await this.saveResult(projectId, run.id, result, tools, idByName, meter);
      return {
        runId: run.id,
        status: "completed",
        taskCount: result.results.length,
        answeredCount: result.answeredCount,
        baselineCorrect: result.baselineCorrect,
        fixedCorrect: result.fixedCorrect,
      };
    } catch (err) {
      await this.saveFailure(projectId, run.id, err, meter);
      return { runId: run.id, status: "failed", taskCount: 0, answeredCount: 0, baselineCorrect: 0, fixedCorrect: null };
    }
  }

  /** The latest check with its tasks and fixes, or null. */
  latest(projectId: string) {
    return this.prisma.usabilityRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      include: { tasks: { orderBy: { toolName: "asc" } }, fixes: { orderBy: { toolName: "asc" } } },
    });
  }

  /**
   * Accept or reject a proposed fix, while the tool plan is under review. An
   * accepted fix goes through the normal tool update (so a clashing rename is
   * refused); if the tool changed since the check, the fix is marked stale
   * instead of overwriting that edit.
   */
  async decideFix(projectId: string, fixId: string, userId: string, decision: "accept" | "reject") {
    const fix = await this.prisma.usabilityFix.findFirst({ where: { id: fixId, run: { projectId } } });
    if (!fix) throw new NotFoundException("Fix not found");
    if (fix.status !== "proposed") throw new ConflictException(`This fix was already ${fix.status}.`);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true } });
    if (!REVIEW_STATUSES.includes(project.status)) {
      throw new ConflictException("Fixes can only be applied while the tool plan is under review.");
    }

    if (decision === "accept") {
      const tool = fix.toolId
        ? await this.prisma.toolCandidate.findFirst({ where: { id: fix.toolId, projectId } })
        : null;
      if (!tool || tool.name !== fix.beforeName || tool.description !== fix.beforeDescription) {
        await this.prisma.usabilityFix.update({ where: { id: fix.id }, data: { status: "stale" } });
        throw new ConflictException("The tool changed after the check, so this fix no longer applies. Run the check again.");
      }
      await this.tools.updateTool(projectId, tool.id, {
        description: fix.afterDescription,
        ...(fix.afterName ? { name: fix.afterName } : {}),
      });
    }

    const status = decision === "accept" ? "accepted" : "rejected";
    const renamed = decision === "accept" && fix.afterName ? ` (renamed to ${fix.afterName})` : "";
    const [updated] = await this.prisma.$transaction([
      this.prisma.usabilityFix.update({
        where: { id: fix.id },
        data: { status, decidedAt: new Date(), decidedByUserId: userId },
      }),
      this.prisma.auditEvent.create({
        data: {
          projectId,
          userId,
          eventType: `usability_fix_${status}`,
          actor: "user",
          summary: `${decision === "accept" ? "Accepted" : "Rejected"} the usability fix for ${fix.toolName}${renamed}.`,
        },
      }),
    ]);
    return updated;
  }

  private async loadTools(projectId: string) {
    const rows = await this.prisma.toolCandidate.findMany({
      where: { projectId, enabled: true },
      include: { endpoints: { include: { endpoint: true } } },
      orderBy: { name: "asc" },
    });
    const tools: UsabilityTool[] = rows.map((t) => {
      const endpoint = t.endpoints[0]?.endpoint;
      return {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as UsabilityTool["inputSchema"],
        method: endpoint?.method ?? "",
        path: endpoint?.path ?? "",
        ...(endpoint?.tag ? { tag: endpoint.tag } : {}),
      };
    });
    return { tools, idByName: new Map(rows.map((t) => [t.name, t.id])) };
  }

  private async saveResult(
    projectId: string,
    runId: string,
    result: CheckResult,
    tools: UsabilityTool[],
    idByName: Map<string, string>,
    meter: Meter,
  ): Promise<void> {
    const toolText = new Map(tools.map((t) => [t.name, t]));
    const answered = result.answeredCount;
    const withFixes = result.fixedCorrect === null ? "" : `; with the suggested fixes, ${result.fixedCorrect} of ${answered}`;
    await this.prisma.$transaction([
      this.prisma.usabilityTask.createMany({
        data: result.results.map((r) => ({
          runId,
          toolId: idByName.get(r.task.toolName) ?? null,
          toolName: r.task.toolName,
          prompt: r.task.prompt,
          expectedArgs: json(r.task.expectedArgs),
          candidateNames: json(r.candidateNames),
          chosenTool: r.answer?.tool ?? null,
          chosenArgs: r.answer ? json(r.answer.arguments) : Prisma.JsonNull,
          outcome: r.outcome.outcome,
          reason: r.outcome.reason ?? null,
        })),
      }),
      this.prisma.usabilityFix.createMany({
        data: result.fixes.map((f) => ({
          runId,
          toolId: idByName.get(f.toolName) ?? null,
          toolName: f.toolName,
          beforeName: f.toolName,
          afterName: f.afterName ?? null,
          beforeDescription: toolText.get(f.toolName)?.description ?? "",
          afterDescription: f.afterDescription,
          missesFixed: f.missesFixed,
          pairedWith: f.pairedWith,
        })),
      }),
      this.prisma.usabilityRun.update({
        where: { id: runId },
        data: {
          status: "completed",
          completedAt: new Date(),
          note: result.note ?? null,
          taskCount: result.results.length,
          answeredCount: answered,
          baselineCorrect: result.baselineCorrect,
          fixedCorrect: result.fixedCorrect,
          ...this.cost(meter),
        },
      }),
      this.prisma.auditEvent.create({
        data: {
          projectId,
          eventType: "usability_checked",
          actor: "agent",
          summary: `Agents chose the right tool for ${result.baselineCorrect} of ${answered} tasks${withFixes}.`,
        },
      }),
    ]);
  }

  private async saveFailure(projectId: string, runId: string, err: unknown, meter: Meter): Promise<void> {
    const reason = redactSecrets(err instanceof Error ? err.message : String(err));
    this.logger.warn(`Usability check ${runId} failed: ${reason}`);
    await this.prisma.$transaction([
      this.prisma.usabilityRun.update({
        where: { id: runId },
        data: { status: "failed", completedAt: new Date(), errorMessage: reason, ...this.cost(meter) },
      }),
      this.prisma.auditEvent.create({
        data: { projectId, eventType: "usability_check_failed", actor: "agent", summary: `Usability check failed: ${reason}` },
      }),
    ]);
  }

  private cost(meter: Meter) {
    return {
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      estimatedCostUsd: estimateCostUsd(meter.model ?? this.llm.model, meter.inputTokens, meter.outputTokens),
      ...(meter.model ? { llmModelId: meter.model } : {}),
    };
  }
}
