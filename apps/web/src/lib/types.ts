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
  endpoints: ToolEndpointRef[];
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
