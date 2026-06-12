import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { GenerationService } from "./generation.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/jwt.strategy";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { RateLimit } from "../common/rate-limit.decorator";
import { JobsService } from "../jobs/jobs.service";

@Controller("projects/:projectId/generation")
@UseGuards(JwtAuthGuard, ProjectOwnershipGuard)
export class GenerationController {
  constructor(
    private readonly generation: GenerationService,
    private readonly jobs: JobsService,
  ) {}

  @Post()
  @HttpCode(200)
  // Generation is CPU/codegen-heavy (and LLM-bound later) — cap it (§24, NFR-007b).
  @RateLimit({ limit: 10, windowMs: 60_000 })
  // Runs inline (returns the result) or enqueues (returns a queued handle) per P6-6.
  generate(@Param("projectId") projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.jobs.enqueueGeneration(projectId, user.id);
  }

  @Get()
  latest(@Param("projectId") projectId: string) {
    return this.generation.getLatest(projectId);
  }

  @Get("download")
  async download(@Param("projectId") projectId: string): Promise<StreamableFile> {
    const { filename, buffer } = await this.generation.downloadZip(projectId);
    return new StreamableFile(buffer, {
      type: "application/zip",
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
