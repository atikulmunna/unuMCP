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

/** Rule-based risk scoring (FR-010, NFR-003). */
export function scoreRisk(e: ExtractedEndpoint, operationType: OperationType): RiskLevel {
  const hay = haystack(e);
  const sensitive = SENSITIVE.test(hay);

  if (operationType === "delete") {
    return sensitive || /user|account|prod/.test(hay) ? "critical" : "high";
  }
  if (operationType === "admin") return "high";
  if (operationType === "auth") return "high";
  if (operationType === "create" || operationType === "update" || operationType === "upload") {
    return sensitive ? "high" : "medium";
  }
  // read / search / download
  return sensitive ? "medium" : "low";
}
