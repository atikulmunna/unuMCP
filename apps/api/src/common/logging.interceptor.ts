import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Observable, tap } from "rxjs";

interface Req {
  method: string;
  url: string;
}
interface Res {
  statusCode: number;
}

/**
 * Structured request logging (P6-7, §24 "Observability"). Emits one JSON line
 * per HTTP request on completion — `{ requestId, method, path, status, durationMs }`
 * — so logs are machine-parseable and each request carries a lightweight trace
 * id (the `requestId`). Kept dependency-free (no pino/OTel) per the MVP scope;
 * the JSON shape is drop-in for a real log shipper later.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    const requestId = randomUUID();
    const startedAt = Date.now();

    const emit = (): void => {
      const res = http.getResponse<Res>();
      this.logger.log(
        JSON.stringify({
          requestId,
          method: req.method,
          path: req.url,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    };

    // Log on both success and error so failed requests are observable too
    // (the AllExceptionsFilter still owns the error response itself).
    return next.handle().pipe(tap({ next: emit, error: emit }));
  }
}
