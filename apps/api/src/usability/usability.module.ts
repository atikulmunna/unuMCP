import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LlmService } from "../llm/llm.service";
import { ToolsModule } from "../tools/tools.module";
import { ToolsService } from "../tools/tools.service";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { UsabilityController } from "./usability.controller";
import { UsabilityService } from "./usability.service";
import { usabilityConfigFromEnv } from "./usability.config";

/** The on-demand agent usability check (config read from env at startup). */
@Module({
  imports: [ToolsModule],
  controllers: [UsabilityController],
  providers: [
    ProjectOwnershipGuard,
    {
      provide: UsabilityService,
      useFactory: (prisma: PrismaService, llm: LlmService, tools: ToolsService) =>
        new UsabilityService(prisma, llm, tools, usabilityConfigFromEnv()),
      inject: [PrismaService, LlmService, ToolsService],
    },
  ],
  exports: [UsabilityService],
})
export class UsabilityModule {}
