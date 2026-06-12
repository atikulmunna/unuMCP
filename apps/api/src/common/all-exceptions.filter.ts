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
 * Single chokepoint for error responses (P6-8, §17). Every error — whether a
 * deliberate `HttpException` from a service or an unexpected throw — is shaped
 * into one envelope that is:
 *   - **clear & actionable**: the service's own message is preserved for 4xx;
 *   - **free of secrets**: the client-facing message and any detail are run
 *     through `redactSecrets` (NFR-001) so a leaked token never reaches the wire;
 *   - **non-leaky for 5xx**: unexpected errors return a generic message — never
 *     a raw internal message or stack — plus a `correlationId`;
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

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string;
    let errors: unknown;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Any 5xx — an unexpected throw or even an explicit 5xx — is treated as
      // not-client-safe: never surface its text or stack, just a generic,
      // traceable message.
      message =
        "An unexpected error occurred. Please try again; if it persists, contact support " +
        `with reference ${correlationId}.`;
    } else if (isHttp) {
      const payload = exception.getResponse();
      if (typeof payload === "string") {
        message = payload;
      } else {
        const obj = payload as Record<string, unknown>;
        if (typeof obj.message === "string") {
          message = obj.message;
        } else if (Array.isArray(obj.message)) {
          message = obj.message.join("; ");
        } else {
          message = exception.message;
        }
        // Validation details: `errors` (our services) or the Zod flatten shape
        // (`fieldErrors`/`formErrors` from ZodValidationPipe).
        errors = obj.errors ?? extractZodErrors(obj);
      }
    } else {
      // Defensive: a non-HttpException always maps to 500 above, but keep a
      // sane fallback if that ever changes.
      message = "An unexpected error occurred.";
    }

    // Client-facing sanitization (NFR-001): redact even deliberate 4xx messages —
    // an actionable message must never carry a secret echoed back from input.
    message = redactSecrets(message);
    if (errors !== undefined) {
      errors = JSON.parse(redactSecrets(JSON.stringify(errors)));
    }

    // Server-side detail for developers, also redacted, keyed by correlationId.
    const detail =
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
    const logLine = `[${correlationId}] ${req.method} ${req.url} -> ${status}: ${redactSecrets(detail)}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(logLine);
    } else {
      this.logger.warn(logLine);
    }

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
