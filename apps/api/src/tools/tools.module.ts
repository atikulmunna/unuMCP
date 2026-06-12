import { Module } from "@nestjs/common";
import { ToolsController } from "./tools.controller";
import { ToolsService } from "./tools.service";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";

@Module({
  controllers: [ToolsController],
  providers: [ToolsService, ProjectOwnershipGuard],
})
export class ToolsModule {}
