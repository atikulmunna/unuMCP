import { Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { TestingService } from "./testing.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { JobsService } from "../jobs/jobs.service";

@Controller("projects/:projectId/test")
@UseGuards(JwtAuthGuard, ProjectOwnershipGuard)
export class TestingController {
  constructor(
    private readonly testing: TestingService,
    private readonly jobs: JobsService,
  ) {}

  @Post()
  @HttpCode(200)
  // Inline (returns results) or enqueued (returns a queued handle) per P6-6.
  run(@Param("projectId") projectId: string) {
    return this.jobs.enqueueTest(projectId);
  }

  @Get()
  results(@Param("projectId") projectId: string) {
    return this.testing.getResults(projectId);
  }
}
