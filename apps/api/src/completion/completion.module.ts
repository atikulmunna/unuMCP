import { Module } from "@nestjs/common";
import { CompletionController } from "./completion.controller";
import { CompletionService } from "./completion.service";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";

@Module({
  controllers: [CompletionController],
  providers: [CompletionService, ProjectOwnershipGuard],
})
export class CompletionModule {}
