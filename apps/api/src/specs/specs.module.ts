import { Module } from "@nestjs/common";
import { SpecsController } from "./specs.controller";
import { SpecsService } from "./specs.service";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";

@Module({
  controllers: [SpecsController],
  providers: [SpecsService, ProjectOwnershipGuard],
})
export class SpecsModule {}
