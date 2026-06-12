import { Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { CompletionService } from "./completion.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/jwt.strategy";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";

@Controller("projects/:projectId/complete")
@UseGuards(JwtAuthGuard, ProjectOwnershipGuard)
export class CompletionController {
  constructor(private readonly completion: CompletionService) {}

  @Post()
  @HttpCode(200)
  complete(@Param("projectId") projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.completion.complete(projectId, user.id);
  }
}
