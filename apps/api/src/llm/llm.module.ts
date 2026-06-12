import { Global, Module } from "@nestjs/common";
import { LlmService, llmConfigFromEnv } from "./llm.service";

/**
 * Provides the LLM seam app-wide (config read from env at startup). Global so
 * any stage (proposal now; repair later) can inject it without re-wiring.
 */
@Global()
@Module({
  providers: [{ provide: LlmService, useFactory: () => new LlmService(llmConfigFromEnv()) }],
  exports: [LlmService],
})
export class LlmModule {}
