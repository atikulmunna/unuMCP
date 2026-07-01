import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@unumcp/db";
import { redactSecrets } from "@unumcp/security-scan";
import { PrismaService } from "../prisma/prisma.service";

/** Project context for a trace — the internal agent tool call belongs to a project. */
export interface LlmTraceContext {
  projectId: string;
}

/** One internal agent tool-call trace (FR-031). Free-text is redacted on write. */
export interface LlmTraceEntry {
  projectId: string;
  /** The internal operation, e.g. `propose_tool_description` | `repair_code`. */
  toolName: string;
  inputSummary: string;
  outputSummary?: string;
  /** `name: message` when the call threw. */
  error?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

const SUMMARY_CAP = 300;
const FIELD_CAP = 1_000;

/**
 * Persists a trace of the platform's own internal agent tool calls — the LLM
 * stages (`propose_tool_description`, `repair_code`) — as `llm_tool_call`
 * `AuditEvent`s (FR-031, §9.10). Each trace records the tool name, an input and
 * output summary, a timestamp (the row's `createdAt`), and any error, with all
 * free-text run through `redactSecrets` (NFR-001) so a token echoed in a summary
 * never lands in the audit trail. Writing a trace must never break the pipeline
 * it observes, so `record` swallows its own failures.
 */
@Injectable()
export class LlmTraceService {
  private readonly logger = new Logger("LlmTraceService");

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: LlmTraceEntry): Promise<void> {
    const status = entry.error ? "error" : "ok";
    const summary = redactSecrets(`${entry.toolName} (${status}): ${entry.inputSummary}`).slice(
      0,
      SUMMARY_CAP,
    );
    const metadata: Record<string, unknown> = {
      toolName: entry.toolName,
      status,
      inputSummary: cap(redactSecrets(entry.inputSummary), FIELD_CAP),
    };
    if (entry.outputSummary !== undefined)
      metadata.outputSummary = cap(redactSecrets(entry.outputSummary), FIELD_CAP);
    if (entry.error !== undefined) metadata.error = cap(redactSecrets(entry.error), FIELD_CAP);
    if (entry.latencyMs !== undefined) metadata.latencyMs = entry.latencyMs;
    if (entry.inputTokens !== undefined) metadata.inputTokens = entry.inputTokens;
    if (entry.outputTokens !== undefined) metadata.outputTokens = entry.outputTokens;

    try {
      await this.prisma.auditEvent.create({
        data: {
          projectId: entry.projectId,
          eventType: "llm_tool_call",
          actor: "agent",
          summary,
          metadata: metadata as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist LLM trace for ${entry.toolName} (${err instanceof Error ? err.name : "error"}).`,
      );
    }
  }
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
