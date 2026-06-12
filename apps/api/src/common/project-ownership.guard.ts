import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Enforces object-level authorization (FR-002b): the authenticated user must
 * own the `:projectId` referenced in the route. Returns 404 (not 403) on a
 * non-owner so resource existence is not leaked. Apply after the JWT guard.
 */
@Injectable()
export class ProjectOwnershipGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as { id: string } | undefined;
    if (!user) throw new UnauthorizedException();

    const projectId: string | undefined = req.params?.projectId ?? req.params?.id;
    if (!projectId) return true;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
    });
    if (!project) throw new NotFoundException("Project not found");

    req.project = project;
    return true;
  }
}
