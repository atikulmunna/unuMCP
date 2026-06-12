import { Global, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { LlmService } from "../llm/llm.service";
import { SANDBOX_RUNNER, dockerSandboxRunner, type SandboxRunner } from "../testing/sandbox-runner";
import { RepairService } from "./repair.service";
import { repairConfigFromEnv } from "./repair.config";

/**
 * Provides the bounded repair loop app-wide (P4-5). Global so the jobs worker
 * can resolve it lazily via `ModuleRef` after a failed test run, without a
 * static dependency that would form a DI cycle. Owns its own `SANDBOX_RUNNER`
 * binding (same default runner the testing module uses).
 */
@Global()
@Module({
  providers: [
    { provide: SANDBOX_RUNNER, useValue: dockerSandboxRunner },
    {
      provide: RepairService,
      useFactory: (prisma: PrismaService, storage: StorageService, sandbox: SandboxRunner, llm: LlmService) =>
        new RepairService(prisma, storage, sandbox, llm, repairConfigFromEnv()),
      inject: [PrismaService, StorageService, SANDBOX_RUNNER, LlmService],
    },
  ],
  exports: [RepairService],
})
export class RepairModule {}
