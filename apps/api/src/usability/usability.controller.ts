import { Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/jwt.strategy";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { RateLimit } from "../common/rate-limit.decorator";
import { JobsService } from "../jobs/jobs.service";
import { UsabilityService } from "./usability.service";

@Controller("projects/:projectId/usability")
@UseGuards(JwtAuthGuard, ProjectOwnershipGuard)
export class UsabilityController {
  constructor(
    private readonly usability: UsabilityService,
    private readonly jobs: JobsService,
  ) {}

  @Post()
  @HttpCode(200)
  // Every check spends LLM calls, so cap it like generation (§24, NFR-007b).
  @RateLimit({ limit: 10, windowMs: 60_000 })
  // Refusals come back at once; the check itself runs inline or on the queue.
  async start(@Param("projectId") projectId: string) {
    await this.usability.assertCanStart(projectId);
    return this.jobs.enqueueUsability(projectId);
  }

  /** The latest check, and whether a check can run at all (the dashboard greys it out). */
  @Get()
  async latest(@Param("projectId") projectId: string) {
    return { llmEnabled: this.usability.llmEnabled, run: await this.usability.latest(projectId) };
  }

  @Post("fixes/:fixId/accept")
  @HttpCode(200)
  accept(
    @Param("projectId") projectId: string,
    @Param("fixId") fixId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usability.decideFix(projectId, fixId, user.id, "accept");
  }

  @Post("fixes/:fixId/reject")
  @HttpCode(200)
  reject(
    @Param("projectId") projectId: string,
    @Param("fixId") fixId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usability.decideFix(projectId, fixId, user.id, "reject");
  }
}
