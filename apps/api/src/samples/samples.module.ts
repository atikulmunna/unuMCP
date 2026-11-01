import { Module } from "@nestjs/common";
import { SpecsModule } from "../specs/specs.module";
import { ToolsModule } from "../tools/tools.module";
import { SamplesController } from "./samples.controller";
import { SamplesService } from "./samples.service";

/** The built-in sample project (no LLM calls; see SamplesService). */
@Module({
  imports: [SpecsModule, ToolsModule],
  controllers: [SamplesController],
  providers: [SamplesService],
})
export class SamplesModule {}
