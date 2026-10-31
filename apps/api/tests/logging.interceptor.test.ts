import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Post,
  type INestApplication,
} from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { LoggingInterceptor } from "../src/common/logging.interceptor";

@Controller("probe")
class ProbeController {
  @Get("ok")
  ok() {
    return { ok: true };
  }

  @Post("created")
  created() {
    return { ok: true };
  }

  @Post("invalid")
  invalid() {
    throw new BadRequestException("nope");
  }

  @Get("boom")
  boom() {
    throw new Error("unexpected");
  }
}

describe("LoggingInterceptor (P6-7)", () => {
  let app: INestApplication;
  const log = vi.spyOn(Logger.prototype, "log");

  /** The status of each request line the interceptor logged, in order. */
  const loggedStatuses = () =>
    log.mock.calls
      .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
      .filter((entry) => entry?.requestId)
      .map((entry) => `${entry.method} ${entry.path} ${entry.status}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(() => log.mockClear());
  afterAll(async () => {
    await app.close();
    log.mockRestore();
  });

  it("logs the status the client received, for successes and failures alike", async () => {
    const server = app.getHttpServer();
    expect((await request(server).get("/probe/ok")).status).toBe(200);
    expect((await request(server).post("/probe/created")).status).toBe(201);
    expect((await request(server).post("/probe/invalid")).status).toBe(400);
    expect((await request(server).get("/probe/boom")).status).toBe(500);

    expect(loggedStatuses()).toEqual([
      "GET /probe/ok 200",
      "POST /probe/created 201",
      "POST /probe/invalid 400",
      "GET /probe/boom 500",
    ]);
  });
});
