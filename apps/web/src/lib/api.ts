import type {
  ApiSpec,
  ArtifactContent,
  AuditEvent,
  AuthResult,
  CompletionResult,
  GenerationLatest,
  Project,
  ProjectStatus,
  RepairAttempt,
  SessionUser,
  TestResult,
  ToolCandidate,
} from "./types";

const TOKEN_KEY = "unumcp.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: string[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  // Some routes (like /auth) are reachable without a session.
  anonymous?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.anonymous) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 401 && !opts.anonymous) {
    clearToken();
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Your session has expired. Please sign in again.");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? safeJson(text) : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, extractMessage(data, res.statusText), extractDetails(data));
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message: unknown }).message;
    if (typeof m === "string") return m;
    if (Array.isArray(m) && typeof m[0] === "string") return m[0];
  }
  return fallback || "Request failed";
}

function extractDetails(data: unknown): string[] | undefined {
  if (data && typeof data === "object" && "errors" in data) {
    const e = (data as { errors: unknown }).errors;
    if (Array.isArray(e)) return e.filter((x): x is string => typeof x === "string");
  }
  return undefined;
}

/** Authenticated binary download (the ZIP route streams `application/zip`). */
async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new ApiError(res.status, "Download failed");
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  return { blob, filename: match?.[1] ?? "mcp-server.zip" };
}

export const api = {
  register: (email: string, password: string, name?: string) =>
    request<AuthResult>("/auth/register", { method: "POST", body: { email, password, name }, anonymous: true }),
  login: (email: string, password: string) =>
    request<AuthResult>("/auth/login", { method: "POST", body: { email, password }, anonymous: true }),
  me: () => request<SessionUser>("/auth/me"),

  projects: {
    list: () => request<Project[]>("/projects"),
    create: (name: string, description?: string) =>
      request<Project>("/projects", { method: "POST", body: { name, description } }),
    get: (id: string) => request<Project>(`/projects/${id}`),
    remove: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),
    audit: (id: string) => request<AuditEvent[]>(`/projects/${id}/audit`),
  },

  spec: {
    get: (projectId: string) => request<ApiSpec | null>(`/projects/${projectId}/spec`),
    upload: (projectId: string, filename: string, content: string) =>
      request<{ specId: string; endpointCount: number }>(`/projects/${projectId}/spec/upload`, {
        method: "POST",
        body: { filename, content },
      }),
  },

  tools: {
    list: (projectId: string) => request<ToolCandidate[]>(`/projects/${projectId}/tools`),
    propose: (projectId: string) =>
      request<ToolCandidate[]>(`/projects/${projectId}/tools/propose`, { method: "POST" }),
    setEnabled: (projectId: string, toolId: string, enabled: boolean) =>
      request<ToolCandidate>(`/projects/${projectId}/tools/${toolId}`, {
        method: "PATCH",
        body: { enabled },
      }),
    approve: (projectId: string) =>
      request<{ approvedCount: number }>(`/projects/${projectId}/tools/approve`, { method: "POST" }),
  },

  generation: {
    run: (projectId: string) =>
      request<{ runId: string; fileCount: number }>(`/projects/${projectId}/generation`, {
        method: "POST",
      }),
    latest: (projectId: string) => request<GenerationLatest | null>(`/projects/${projectId}/generation`),
    artifact: (projectId: string, artifactId: string) =>
      request<ArtifactContent>(`/projects/${projectId}/generation/artifacts/${artifactId}`),
    repairs: (projectId: string) =>
      request<RepairAttempt[]>(`/projects/${projectId}/generation/repairs`),
    download: (projectId: string) => download(`/projects/${projectId}/generation/download`),
  },

  testing: {
    run: (projectId: string) => request<TestResult>(`/projects/${projectId}/test`, { method: "POST" }),
    // GET returns `{ runId, results }`; the UI only needs the result rows.
    results: async (projectId: string) => {
      const res = await request<{ runId: string; results: TestResult[] } | null>(
        `/projects/${projectId}/test`,
      );
      return res?.results ?? [];
    },
  },

  complete: (projectId: string) =>
    request<CompletionResult>(`/projects/${projectId}/complete`, { method: "POST" }),
};

export type ProjectStatusValue = ProjectStatus;
