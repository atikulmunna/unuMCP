import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RATE_LIMIT_KEY, type RateLimitOptions } from "./rate-limit.decorator";
import { RateLimitStore } from "./rate-limit.store";

export interface RateLimitConfig {
  disabled: boolean;
  defaultLimit: number;
  defaultWindowMs: number;
}

interface Req {
  ip?: string;
  method: string;
  url: string;
  socket?: { remoteAddress?: string };
}
interface Res {
  setHeader(name: string, value: string | number): void;
}

/** Resolve the global config from env (production defaults; tunable per deploy). */
export function rateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    disabled: env.RATE_LIMIT_DISABLED === "true",
    defaultLimit: Number(env.RATE_LIMIT_MAX ?? 60),
    defaultWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  };
}

/**
 * Per-IP, per-endpoint fixed-window rate limiter (P6-5, §24). Runs as a global
 * guard: every handler gets the global default; sensitive ones tighten it with
 * `@RateLimit(...)`. On breach it sets `Retry-After` and throws 429, which the
 * `AllExceptionsFilter` shapes into the standard envelope. Disabled via
 * `RATE_LIMIT_DISABLED=true` (used in the test suite so it can't introduce flake).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: RateLimitConfig,
    private readonly store: RateLimitStore = new RateLimitStore(),
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.disabled) return true;

    const override = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const limit = override?.limit ?? this.config.defaultLimit;
    const windowMs = override?.windowMs ?? this.config.defaultWindowMs;

    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Res>();

    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    // One bucket per (endpoint, IP) so a burst on one route can't exhaust others.
    const bucket = `${context.getClass().name}.${context.getHandler().name}`;
    const key = `${bucket}:${ip}`;

    const decision = this.store.hit(key, limit, windowMs, Date.now());
    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", decision.remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil(decision.resetAt / 1000));

    if (!decision.allowed) {
      res.setHeader("Retry-After", decision.retryAfterSec);
      throw new HttpException(
        `Too many requests. Please try again in ${decision.retryAfterSec} second(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
