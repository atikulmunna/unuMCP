import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";

@Module({
  controllers: [ProjectsController],
  providers: [ProjectOwnershipGuard],
})
export class ProjectsModule {}
