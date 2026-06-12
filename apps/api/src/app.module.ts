import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { LoggingInterceptor } from "./common/logging.interceptor";
import { RateLimitGuard, rateLimitConfigFromEnv } from "./common/rate-limit.guard";
import { RateLimitStore } from "./common/rate-limit.store";
import { LlmModule } from "./llm/llm.module";
import { JobsModule } from "./jobs/jobs.module";
import { RepairModule } from "./repair/repair.module";
import { MetricsModule } from "./metrics/metrics.module";
import { PrismaModule } from "./prisma/prisma.module";
import { StorageModule } from "./storage/storage.module";
import { AuthModule } from "./auth/auth.module";
import { ProjectsModule } from "./projects/projects.module";
import { SpecsModule } from "./specs/specs.module";
import { ToolsModule } from "./tools/tools.module";
import { GenerationModule } from "./generation/generation.module";
import { TestingModule } from "./testing/testing.module";
import { CompletionModule } from "./completion/completion.module";

@Module({
  imports: [
    PrismaModule,
    LlmModule,
    RepairModule,
    JobsModule,
    StorageModule,
    AuthModule,
    ProjectsModule,
    SpecsModule,
    ToolsModule,
    GenerationModule,
    TestingModule,
    CompletionModule,
    MetricsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // One shared store across requests; guard config read from env at startup.
    RateLimitStore,
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, store: RateLimitStore) =>
        new RateLimitGuard(reflector, rateLimitConfigFromEnv(), store),
      inject: [Reflector, RateLimitStore],
    },
  ],
})
export class AppModule {}
