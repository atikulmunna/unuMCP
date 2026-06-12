import { Global, Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { JobsService } from "./jobs.service";
import { JobReconciler } from "./job-reconciler";
import { jobsConfigFromEnv } from "./jobs.config";

/**
 * Background-job infrastructure (P6-6). Global so any controller can enqueue
 * without re-wiring. `JobsService` resolves domain services lazily (ModuleRef),
 * so this module needs no static import of the Generation/Testing modules.
 */
@Global()
@Module({
  providers: [
    {
      provide: JobsService,
      useFactory: (moduleRef: ModuleRef) => new JobsService(jobsConfigFromEnv(), moduleRef),
      inject: [ModuleRef],
    },
    JobReconciler,
  ],
  exports: [JobsService],
})
export class JobsModule {}
