import { Global, Module } from "@nestjs/common";
import { LlmService, llmConfigFromEnv } from "./llm.service";
import { LlmTraceService } from "./llm-trace.service";

/**
 * Provides the LLM seam app-wide (config read from env at startup). Global so
 * any stage (proposal, repair) can inject it without re-wiring. The seam also
 * owns internal agent tool-call tracing (FR-031) via `LlmTraceService`, so every
 * LLM call is recorded from one place regardless of the call site.
 */
@Global()
@Module({
  providers: [
    LlmTraceService,
    {
      provide: LlmService,
      useFactory: (trace: LlmTraceService) => new LlmService(llmConfigFromEnv(), undefined, trace),
      inject: [LlmTraceService],
    },
  ],
  exports: [LlmService],
})
export class LlmModule {}
