// Shapes mirrored from the API responses (apps/api). Kept intentionally narrow
// to what the dashboard actually renders.

export type ProjectStatus =
  | "DRAFT"
  | "SPEC_UPLOADED"
  | "SPEC_VALIDATED"
  | "ENDPOINTS_ANALYZED"
  | "TOOLS_PROPOSED"
  | "AWAITING_USER_APPROVAL"
  | "TOOLS_APPROVED"
  | "CODE_GENERATING"
  | "TEST_GENERATING"
  | "TEST_RUNNING"
  | "REPAIRING_FAILED_CODE"
  | "TESTS_PASSED"
  | "PACKAGING"
  | "COMPLETED"
  | "COMPLETED_WITH_WARNINGS"
  | "SPEC_INVALID"
  | "GENERATION_FAILED"
  | "TESTS_FAILED"
  | "SANDBOX_FAILED"
  | "PACKAGE_FAILED"
  | "CANCELLED";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthResult {
  accessToken: string;
  user: SessionUser;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  /** The built-in sample this project was created from; null for your own projects. */
  sample: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DetectedAuthScheme {
  type: string;
  httpScheme?: string;
  in?: "header" | "query" | "cookie";
  paramName?: string;
}

export interface DetectedAuth {
  required: boolean;
  assumed: boolean;
  needsUserConfig: boolean;
  schemes: DetectedAuthScheme[];
}

export interface ApiSpec {
  id: string;
  title: string | null;
  version: string | null;
  openapiVersion: string | null;
  baseUrl: string | null;
  validationStatus: "valid" | "invalid";
  validationErrors: string[] | null;
  detectedAuth: DetectedAuth | null;
  createdAt: string;
}

export interface ToolEndpointRef {
  endpoint: { method: string; path: string; operationId: string | null };
}

export interface ToolCandidate {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  approved: boolean;
  riskLevel: RiskLevel;
  createdBy: "agent" | "user";
  /** Its endpoint's OpenAPI tag (or first path segment), as a snake_case name. */
  group: string;
  endpoints: ToolEndpointRef[];
}

export type UsabilityOutcome = "correct" | "wrong_tool" | "bad_args" | "no_answer";

export interface UsabilityTask {
  id: string;
  toolName: string;
  prompt: string;
  chosenTool: string | null;
  outcome: UsabilityOutcome;
  reason: string | null;
}

export interface UsabilityFix {
  id: string;
  toolName: string;
  beforeName: string;
  afterName: string | null;
  beforeDescription: string;
  afterDescription: string;
  missesFixed: number;
  /** Tools whose fixes were written with this one, because the agent confused them. */
  pairedWith: string[];
  status: "proposed" | "accepted" | "rejected" | "stale";
}

export interface UsabilityRun {
  id: string;
  status: "running" | "completed" | "failed";
  errorMessage: string | null;
  note: string | null;
  taskCount: number;
  answeredCount: number;
  baselineCorrect: number;
  fixedCorrect: number | null;
  /** Prisma Decimal, serialized as a string. */
  estimatedCostUsd: string | number;
  tasks: UsabilityTask[];
  fixes: UsabilityFix[];
}

export interface UsabilityState {
  /** False when no LLM is configured: the check can't run. */
  llmEnabled: boolean;
  run: UsabilityRun | null;
}

export type ArtifactType = "source_file" | "test_file" | "archive" | "readme";

export interface GenerationArtifact {
  id: string;
  path: string;
  artifactType: ArtifactType;
  contentHash: string;
}

export interface ArtifactContent {
  path: string;
  artifactType: ArtifactType;
  content: string;
}

export interface RepairAttempt {
  attemptNumber: number;
  failureSummary: string;
  diff: string;
  outcome: "passed" | "failed";
  createdAt: string;
}

export interface GenerationRun {
  id: string;
  status: "running" | "failed" | "passed" | "passed_with_warnings" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  mcpSdkVersion: string | null;
}

export interface GenerationLatest {
  run: GenerationRun;
  artifacts: GenerationArtifact[];
}

export interface TestResult {
  id: string;
  suite: string;
  status: "passed" | "failed" | "skipped" | "errored";
  durationMs: number;
  totalTestCount: number;
  failingTestCount: number;
  logExcerpt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actor: "user" | "agent" | "system";
  summary: string;
  createdAt: string;
}

export interface SandboxLogEvent {
  type: "log" | "status" | "done";
  phase?: "install" | "test";
  chunk?: string;
  status?: string;
}

export interface CompletionResult {
  status: ProjectStatus;
  warnings: string[];
}
