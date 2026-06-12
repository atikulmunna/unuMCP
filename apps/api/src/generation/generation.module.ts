import { Module } from "@nestjs/common";
import { GenerationController } from "./generation.controller";
import { GenerationService } from "./generation.service";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";

@Module({
  controllers: [GenerationController],
  providers: [GenerationService, ProjectOwnershipGuard],
})
export class GenerationModule {}
