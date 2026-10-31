import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "@unumcp/security-scan";

/** Minimal shape of the bits of the Express req/res we touch (avoids a types dep). */
interface Req {
  method: string;
  url: string;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

/** Consistent, sanitized error envelope returned to every client (§17). */
interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  errors?: unknown;
  correlationId: string;
  timestamp: string;
  path: string;
}

/**
 * Single chokepoint for error responses (P6-8, §17). Every error, whether a
 * deliberate `HttpException` from a service or an unexpected throw, is shaped
 * into one envelope that is:
 *   - **clear & actionable**: the service's own message is preserved for 4xx;
 *   - **free of secrets**: the client-facing message and any detail are run
 *     through `redactSecrets` (NFR-001) so a leaked token never reaches the wire;
 *   - **non-leaky for 5xx**: unexpected errors return a generic message (never
 *     a raw internal message or stack) plus a `correlationId`;
 *   - **linked to logs**: the same `correlationId` is logged server-side with the
 *     (redacted) detail, so developers can trace it (§17.2).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Res>();
    const req = ctx.getRequest<Req>();
    const correlationId = randomUUID();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const { message, errors } = clientFacing(exception, status, correlationId);
    this.logDetail(exception, req, status, correlationId);

    const body: ErrorBody = {
      statusCode: status,
      error: reasonPhrase(status),
      message,
      ...(errors !== undefined ? { errors } : {}),
      correlationId,
      timestamp: new Date().toISOString(),
      path: req.url,
    };
    res.status(status).json(body);
  }

  /** Server-side detail for developers, also redacted, keyed by correlationId. */
  private logDetail(exception: unknown, req: Req, status: number, correlationId: string): void {
    const detail =
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
    const logLine = `[${correlationId}] ${req.method} ${req.url} -> ${status}: ${redactSecrets(detail)}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(logLine);
    } else {
      this.logger.warn(logLine);
    }
  }
}

/**
 * What the client may see: the service's own message and validation details
 * for a 4xx, a generic traceable message for any 5xx. Both are redacted
 * (NFR-001): even a deliberate 4xx must never echo a secret back from input.
 */
function clientFacing(
  exception: unknown,
  status: number,
  correlationId: string,
): { message: string; errors?: unknown } {
  const { message, errors } = unredactedMessage(exception, status, correlationId);
  return {
    message: redactSecrets(message),
    ...(errors !== undefined ? { errors: JSON.parse(redactSecrets(JSON.stringify(errors))) } : {}),
  };
}

function unredactedMessage(
  exception: unknown,
  status: number,
  correlationId: string,
): { message: string; errors?: unknown } {
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    // Any 5xx (an unexpected throw or even an explicit 5xx) is treated as
    // not-client-safe: never surface its text or stack, just a generic,
    // traceable message.
    return {
      message:
        "An unexpected error occurred. Please try again; if it persists, contact support " +
        `with reference ${correlationId}.`,
    };
  }
  // Defensive: a non-HttpException always maps to 500 above, but keep a sane
  // fallback if that ever changes.
  if (!(exception instanceof HttpException)) return { message: "An unexpected error occurred." };

  const payload = exception.getResponse();
  if (typeof payload === "string") return { message: payload };
  const obj = payload as Record<string, unknown>;
  const message =
    typeof obj.message === "string"
      ? obj.message
      : Array.isArray(obj.message)
        ? obj.message.join("; ")
        : exception.message;
  // Validation details: `errors` (our services) or the Zod flatten shape
  // (`fieldErrors`/`formErrors` from ZodValidationPipe).
  return { message, errors: obj.errors ?? extractZodErrors(obj) };
}

/** Pull Zod's `flatten()` payload (`{ formErrors, fieldErrors }`) if present. */
function extractZodErrors(obj: Record<string, unknown>): unknown {
  if ("fieldErrors" in obj || "formErrors" in obj) {
    return { fieldErrors: obj.fieldErrors, formErrors: obj.formErrors };
  }
  return undefined;
}

/** Short, human label for the status code (the envelope's `error` field). */
function reasonPhrase(status: number): string {
  const known: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: "Bad Request",
    [HttpStatus.UNAUTHORIZED]: "Unauthorized",
    [HttpStatus.FORBIDDEN]: "Forbidden",
    [HttpStatus.NOT_FOUND]: "Not Found",
    [HttpStatus.CONFLICT]: "Conflict",
    [HttpStatus.UNPROCESSABLE_ENTITY]: "Unprocessable Entity",
    [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
  };
  return known[status] ?? (status >= 500 ? "Internal Server Error" : "Error");
}
