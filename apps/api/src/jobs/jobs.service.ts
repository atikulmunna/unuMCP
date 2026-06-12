import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Queue, Worker, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { TestStatus } from "@unumcp/db";
import { GenerationService } from "../generation/generation.service";
import { TestingService } from "../testing/testing.service";
import { RepairService } from "../repair/repair.service";
import type { JobsConfig } from "./jobs.config";

const QUEUE = "unumcp";
export type JobName = "generate" | "test";
export interface JobData {
  projectId: string;
  userId?: string;
}

export interface QueuedHandle {
  status: "queued";
  kind: JobName;
  projectId: string;
  jobId: string;
}

/**
 * Durable background jobs (P6-6, NFR-006). Generation and sandbox testing are
 * long-running and must survive a restart; this routes them through a BullMQ
 * queue (Redis) when configured, or runs them inline otherwise.
 *
 * The worker resolves the domain services lazily via `ModuleRef` (not
 * constructor injection) so this module has no static dependency on the
 * Generation/Testing modules — avoiding a DI cycle (controllers there depend on
 * this service). Idempotency / no-duplicate-artifacts is enforced at the domain
 * layer (`GenerationService` refuses a second concurrent run), so retries and
 * re-enqueues are safe.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("JobsService");
  private queue: Queue<JobData> | null = null;
  private worker: Worker<JobData> | null = null;
  private readonly connections: Redis[] = [];

  constructor(
    private readonly config: JobsConfig,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    if (this.config.inline) {
      this.logger.log("Jobs run inline (no REDIS_URL). Set REDIS_URL for the durable queue.");
      return;
    }
    this.queue = new Queue<JobData>(QUEUE, {
      connection: this.connect(),
      defaultJobOptions: {
        attempts: this.config.attempts,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    });
    this.worker = new Worker<JobData>(QUEUE, (job) => this.run(job.name as JobName, job.data), {
      connection: this.connect(),
      concurrency: this.config.concurrency,
    });
    this.worker.on("failed", (job, err) =>
      this.logger.warn(`Job ${job?.id ?? "?"} (${job?.name}) failed: ${err.message}`),
    );
    this.logger.log(`Job queue ready (Redis), concurrency=${this.config.concurrency}.`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }

  enqueueGeneration(projectId: string, userId: string): Promise<unknown> {
    return this.enqueue("generate", { projectId, userId });
  }

  enqueueTest(projectId: string): Promise<unknown> {
    return this.enqueue("test", { projectId });
  }

  private async enqueue(name: JobName, data: JobData): Promise<unknown> {
    // Inline: run now and return the real result (preserves the synchronous API).
    if (this.config.inline || !this.queue) {
      return this.run(name, data);
    }
    const job = await this.queue.add(name, data);
    const handle: QueuedHandle = {
      status: "queued",
      kind: name,
      projectId: data.projectId,
      jobId: job.id ?? "",
    };
    return handle;
  }

  /** Execute a job by resolving the owning service from the DI container. */
  private async run(name: JobName, data: JobData): Promise<unknown> {
    if (name === "generate") {
      return this.moduleRef
        .get(GenerationService, { strict: false })
        .generate(data.projectId, data.userId ?? "");
    }
    const result = await this.moduleRef
      .get(TestingService, { strict: false })
      .runTests(data.projectId);
    // A clean test failure feeds the bounded repair loop (P4-5). Infra/sandbox
    // failures ("errored") aren't fixable by editing code, so we leave them.
    if (result.status === TestStatus.failed) {
      const repair = this.moduleRef.get(RepairService, { strict: false });
      if (repair.enabled) await repair.repairFailingRun(data.projectId);
    }
    return result;
  }

  private connect(): Redis {
    // BullMQ requires maxRetriesPerRequest: null on the blocking connection.
    const conn = new IORedis(this.config.redisUrl as string, { maxRetriesPerRequest: null });
    this.connections.push(conn);
    return conn;
  }
}
