import { Injectable } from "@nestjs/common";
import { Prisma, type Project, type ToolCandidate, type UsabilityOutcome } from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";
import { SpecsService } from "../specs/specs.service";
import { ToolsService } from "../tools/tools.service";
import { ACME_BILLING_SPEC } from "./acme-billing.openapi";
import { ACME_BILLING_RECORDED } from "./acme-billing.recorded";

export const ACME_BILLING_SAMPLE = "acme-billing";

const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * The built-in sample project. The Acme Billing spec goes through the real
 * pipeline (upload, then the deterministic tool plan), and the agent usability
 * check Claude ran on that plan once (scripts/record-sample.mts) is stored as
 * the project's latest check. So creating a sample never calls an LLM: the
 * demo shows the check and its fixes without an API key, and anyone can accept
 * or reject the fixes, generate the server and test it as usual.
 */
@Injectable()
export class SamplesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly specs: SpecsService,
    private readonly tools: ToolsService,
  ) {}

  async create(userId: string): Promise<Project> {
    const project = await this.prisma.project.create({
      data: {
        userId,
        name: "Acme Billing (sample)",
        description: "A small billing API, with a recorded agent usability check you can review.",
        sample: ACME_BILLING_SAMPLE,
      },
    });
    try {
      await this.specs.upload(project.id, "acme-billing.json", JSON.stringify(ACME_BILLING_SPEC));
      await this.tools.propose(project.id, { useLlm: false });
      await this.addRecordedCheck(project.id);
    } catch (err) {
      await this.prisma.project.delete({ where: { id: project.id } });
      throw err;
    }
    return this.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  }

  private async addRecordedCheck(projectId: string): Promise<void> {
    const recorded = ACME_BILLING_RECORDED;
    const tools = await this.prisma.toolCandidate.findMany({ where: { projectId } });
    const toolOf = byName(tools);
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.usabilityRun.create({
        data: {
          projectId,
          status: "completed",
          completedAt: new Date(),
          note: recorded.note,
          llmModelId: recorded.model,
          inputTokens: recorded.inputTokens,
          outputTokens: recorded.outputTokens,
          estimatedCostUsd: new Prisma.Decimal(recorded.estimatedCostUsd),
          taskCount: recorded.taskCount,
          answeredCount: recorded.answeredCount,
          baselineCorrect: recorded.baselineCorrect,
          fixedCorrect: recorded.fixedCorrect,
        },
      });
      await tx.usabilityTask.createMany({
        data: recorded.tasks.map((t) => ({
          runId: run.id,
          toolId: toolOf(t.toolName).id,
          toolName: t.toolName,
          prompt: t.prompt,
          expectedArgs: json(t.expectedArgs),
          candidateNames: json(t.candidateNames),
          chosenTool: t.chosenTool,
          chosenArgs: t.chosenArgs === null ? Prisma.JsonNull : json(t.chosenArgs),
          outcome: t.outcome as UsabilityOutcome,
          reason: t.reason,
        })),
      });
      await tx.usabilityFix.createMany({
        data: recorded.fixes.map((f) => ({
          runId: run.id,
          toolId: toolOf(f.toolName).id,
          toolName: f.toolName,
          beforeName: f.toolName,
          afterName: f.afterName,
          beforeDescription: toolOf(f.toolName).description,
          afterDescription: f.afterDescription,
          missesFixed: f.missesFixed,
          pairedWith: f.pairedWith,
        })),
      });
      await tx.auditEvent.create({
        data: {
          projectId,
          eventType: "sample_created",
          actor: "system",
          summary:
            `Sample project. Its agent usability check ran once with ${recorded.model} on ` +
            `${recorded.recordedOn} ($${recorded.estimatedCostUsd}) and was recorded, so opening it makes no LLM calls.`,
        },
      });
    });
  }
}

/** Look tools up by name, failing loudly when the recording no longer matches the tool plan. */
function byName(tools: ToolCandidate[]): (name: string) => ToolCandidate {
  const map = new Map(tools.map((t) => [t.name, t]));
  return (name) => {
    const tool = map.get(name);
    if (!tool) {
      throw new Error(
        `The recorded sample check names a tool (${name}) that the tool plan no longer has; re-record it with scripts/record-sample.mts.`,
      );
    }
    return tool;
  };
}
