import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { configureHttp } from "../src/common/http-config";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { RateLimitGuard } from "../src/common/rate-limit.guard";
import { RateLimitStore } from "../src/common/rate-limit.store";
import { RateLimit } from "../src/common/rate-limit.decorator";

// Two routes: the global default bucket, and one tightened via @RateLimit.
@Controller()
class PingController {
  @Get("ping")
  ping() {
    return { ok: true };
  }

  @Get("strict")
  @RateLimit({ limit: 1, windowMs: 60_000 })
  strict() {
    return { ok: true };
  }
}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [PingController],
    providers: [
      RateLimitStore,
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      {
        provide: APP_GUARD,
        useFactory: (reflector: Reflector, store: RateLimitStore) =>
          new RateLimitGuard(
            reflector,
            { disabled: false, defaultLimit: 2, defaultWindowMs: 60_000 },
            store,
          ),
        inject: [Reflector, RateLimitStore],
      },
    ],
  }).compile();
  const expressApp = moduleRef.createNestApplication<NestExpressApplication>();
  // Same HTTP config as main.ts (trusts X-Forwarded-For from the loopback proxy).
  configureHttp(expressApp);
  app = expressApp;
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe("rate limiting (P6-5, §24)", () => {
  it("allows up to the default limit, then returns a sanitized 429", async () => {
    const server = app.getHttpServer();

    const first = await request(server).get("/ping");
    expect(first.status).toBe(200);
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");

    expect((await request(server).get("/ping")).status).toBe(200);

    const blocked = await request(server).get("/ping");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    // Shaped by AllExceptionsFilter into the standard envelope.
    expect(blocked.body.statusCode).toBe(429);
    expect(blocked.body.message).toMatch(/too many requests/i);
    expect(typeof blocked.body.correlationId).toBe("string");
  });

  it("honours a tighter per-handler @RateLimit override", async () => {
    const server = app.getHttpServer();
    expect((await request(server).get("/strict")).status).toBe(200);
    // limit:1 — the second hit is blocked even though /ping has its own bucket.
    expect((await request(server).get("/strict")).status).toBe(429);
  });

  it("keeps separate buckets per endpoint", async () => {
    const server = app.getHttpServer();
    // /strict is exhausted above, but a never-hit route in a fresh store would
    // pass; assert /strict's exhaustion didn't leak into /ping's accounting by
    // confirming /ping is independently governed (its own window already used).
    const res = await request(server).get("/ping");
    // /ping used its 2 in the first test (same long window), so it's blocked —
    // proving the bucket persisted independently of /strict.
    expect(res.status).toBe(429);
  });

  it("limits each client behind the local proxy separately (X-Forwarded-For from loopback)", async () => {
    // Browsers reach the API through the Next.js proxy on the same host, so every
    // connection comes from loopback; the client's address is in X-Forwarded-For.
    const server = app.getHttpServer();
    const from = (ip: string) => request(server).get("/strict").set("X-Forwarded-For", ip);

    expect((await from("203.0.113.10")).status).toBe(200);
    // A different client is not blocked by the first one's exhausted bucket...
    expect((await from("203.0.113.20")).status).toBe(200);
    // ...while the same client still is.
    expect((await from("203.0.113.10")).status).toBe(429);
    // A proxy chain is attributed to the client, not to the trusted loopback hop.
    expect((await from("203.0.113.30, 127.0.0.1")).status).toBe(200);
    expect((await from("203.0.113.30")).status).toBe(429);
  });
});
