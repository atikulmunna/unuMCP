import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ToolsService } from "./tools.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/jwt.strategy";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { setGroupSchema, updateToolSchema, type SetGroupInput, type UpdateToolInput } from "./schemas";

@Controller("projects/:projectId/tools")
@UseGuards(JwtAuthGuard, ProjectOwnershipGuard)
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Post("propose")
  propose(@Param("projectId") projectId: string) {
    return this.tools.propose(projectId);
  }

  @Get()
  list(@Param("projectId") projectId: string) {
    return this.tools.list(projectId);
  }

  @Patch(":toolId")
  update(
    @Param("projectId") projectId: string,
    @Param("toolId") toolId: string,
    @Body(new ZodValidationPipe(updateToolSchema)) body: UpdateToolInput,
  ) {
    return this.tools.updateTool(projectId, toolId, body);
  }

  /** Turn a group of tools on (its high and critical ones stay off) or off. */
  @Post("groups/:group")
  @HttpCode(200)
  setGroup(
    @Param("projectId") projectId: string,
    @Param("group") group: string,
    @Body(new ZodValidationPipe(setGroupSchema)) body: SetGroupInput,
  ) {
    return this.tools.setGroupEnabled(projectId, group, body.enabled);
  }

  @Post("approve")
  @HttpCode(200)
  approve(@Param("projectId") projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tools.approve(projectId, user.id);
  }
}
