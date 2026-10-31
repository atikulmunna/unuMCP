import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Observable } from "rxjs";

interface Req {
  method: string;
  url: string;
}
interface Res {
  statusCode: number;
  once(event: "finish", listener: () => void): unknown;
}

/**
 * Structured request logging (P6-7, §24 "Observability"). Emits one JSON line
 * per HTTP request on completion (`{ requestId, method, path, status, durationMs }`),
 * so logs are machine-parseable and each request carries a lightweight trace
 * id (the `requestId`). Kept dependency-free (no pino/OTel) per the MVP scope;
 * the JSON shape is drop-in for a real log shipper later.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Res>();
    const requestId = randomUUID();
    const startedAt = Date.now();

    // Log once the response is sent, so the status is the one the client got:
    // for a failed request the exception filter sets it after this interceptor
    // has seen the error.
    res.once("finish", () =>
      this.logger.log(
        JSON.stringify({
          requestId,
          method: req.method,
          path: req.url,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      ),
    );
    return next.handle();
  }
}
