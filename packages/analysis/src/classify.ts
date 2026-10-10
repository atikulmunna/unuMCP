import type { ExtractedEndpoint } from "@unumcp/openapi";
import type { OperationType, RiskLevel } from "./types";

function haystack(e: ExtractedEndpoint): string {
  return `${e.path} ${e.operationId ?? ""}`.toLowerCase();
}

/** Rule-based operation classification (FR-009). LLM handles ambiguity later. */
export function classifyEndpoint(e: ExtractedEndpoint): OperationType {
  const method = e.method.toLowerCase();
  const hay = haystack(e);

  if (/\b(login|logout|token|oauth|auth|session)\b/.test(hay)) return "auth";
  if (/\badmin\b/.test(hay)) return "admin";

  if (method === "delete") return "delete";
  if (method === "put" || method === "patch") return "update";
  if (method === "post") {
    if (/search|query|find/.test(hay)) return "search";
    if (/upload|import/.test(hay)) return "upload";
    return "create";
  }
  if (method === "get") {
    if (/download|export/.test(hay)) return "download";
    if (/search|list|find/.test(hay)) return "search";
    return "read";
  }
  return "unknown";
}

const SENSITIVE =
  /payment|billing|charge|invoice|card|secret|password|token|key|credential|permission|role/;

/**
 * Actions named in the path or operationId that are hard or impossible to
 * undo, or that hand control to someone else. The HTTP method alone misses
 * them: GitHub's `PUT .../pulls/{n}/merge` and `POST .../transfer` look like
 * ordinary updates. Whole words, with plural and past-tense endings.
 */
const CRITICAL_ACTIONS = /\b(?:transfer|purge|destroy|wipe|erase)(?:s|es|ed|d)?\b/;
const HIGH_ACTIONS =
  /\b(?:merge|revoke|suspend|ban|reset|rotate|regenerate|publish|deploy|rollback|terminate|remove|delete|force)(?:s|es|ed|d)?\b/;

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The higher of two risk levels. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/** Rule-based risk scoring (FR-010, NFR-003). */
export function scoreRisk(e: ExtractedEndpoint, operationType: OperationType): RiskLevel {
  const hay = haystack(e);
  const sensitive = SENSITIVE.test(hay);

  let risk: RiskLevel;
  if (operationType === "delete") {
    risk = sensitive || /user|account|prod/.test(hay) ? "critical" : "high";
  } else if (operationType === "admin" || operationType === "auth") {
    risk = "high";
  } else if (operationType === "create" || operationType === "update" || operationType === "upload") {
    risk = sensitive ? "high" : "medium";
  } else {
    // read / search / download: action words name what is read, not done.
    return sensitive ? "medium" : "low";
  }

  // Action words can only raise the risk of an operation that changes something.
  if (CRITICAL_ACTIONS.test(hay)) return "critical";
  if (HIGH_ACTIONS.test(hay)) return maxRisk(risk, "high");
  return risk;
}
