import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { SpecsService } from "./specs.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RateLimit } from "../common/rate-limit.decorator";
import { uploadSpecSchema, type UploadSpecInput } from "./schemas";

@Controller("projects/:projectId")
@UseGuards(JwtAuthGuard, ProjectOwnershipGuard)
export class SpecsController {
  constructor(private readonly specs: SpecsService) {}

  @Post("spec/upload")
  // Spec upload parses + dereferences an untrusted document — cap it (§24).
  @RateLimit({ limit: 20, windowMs: 60_000 })
  upload(
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(uploadSpecSchema)) body: UploadSpecInput,
  ) {
    return this.specs.upload(projectId, body.filename, body.content);
  }

  @Get("spec")
  getSpec(@Param("projectId") projectId: string) {
    return this.specs.getLatestSpec(projectId);
  }

  @Get("endpoints")
  listEndpoints(@Param("projectId") projectId: string) {
    return this.specs.listEndpoints(projectId);
  }
}
