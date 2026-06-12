import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/jwt.strategy";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  createProjectSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "./schemas";

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
  ) {
    return this.prisma.project.create({
      data: { userId: user.id, name: body.name, description: body.description ?? null },
    });
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.project.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
  }

  @Get(":projectId")
  @UseGuards(ProjectOwnershipGuard)
  get(@Param("projectId") projectId: string) {
    return this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  }

  @Get(":projectId/audit")
  @UseGuards(ProjectOwnershipGuard)
  audit(@Param("projectId") projectId: string) {
    return this.prisma.auditEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
  }

  @Patch(":projectId")
  @UseGuards(ProjectOwnershipGuard)
  update(
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
  ) {
    return this.prisma.project.update({ where: { id: projectId }, data: body });
  }

  @Delete(":projectId")
  @UseGuards(ProjectOwnershipGuard)
  @HttpCode(204)
  async remove(@Param("projectId") projectId: string): Promise<void> {
    await this.prisma.project.delete({ where: { id: projectId } });
  }
}
