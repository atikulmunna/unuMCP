import { BadRequestException, Injectable } from "@nestjs/common";
import {
  dereferenceSpec,
  detectAuth,
  extractEndpoints,
  parseSpec,
  toCycleSafe,
  validateSpec,
} from "@unumcp/openapi";
import { Prisma } from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

@Injectable()
export class SpecsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Store → parse → validate → dereference → extract → persist (FR-006/007/008). */
  async upload(projectId: string, filename: string, content: string) {
    const originalFileUrl = await this.storage.save(
      `${projectId}/${Date.now()}-${filename}`,
      content,
    );

    const parsed = parseSpec(content);
    if (!parsed.ok || !parsed.doc) {
      await this.recordInvalid(projectId, originalFileUrl, null, [parsed.error ?? "Parse failed"]);
      throw new BadRequestException({ message: "Could not parse spec", errors: [parsed.error] });
    }

    const validation = validateSpec(parsed.doc);
    if (!validation.valid) {
      await this.recordInvalid(projectId, originalFileUrl, parsed.doc, validation.errors);
      throw new BadRequestException({
        message: "Invalid OpenAPI specification",
        errors: validation.errors,
      });
    }

    const deref = await dereferenceSpec(parsed.doc);
    const endpoints = extractEndpoints(deref);
    const auth = detectAuth(deref);

    const spec = await this.prisma.$transaction(async (tx) => {
      const created = await tx.apiSpec.create({
        data: {
          projectId,
          originalFileUrl,
          parsedJson: parsed.doc as unknown as Prisma.InputJsonValue,
          openapiVersion: validation.openapiVersion ?? null,
          title: validation.title ?? null,
          version: validation.version ?? null,
          baseUrl: validation.baseUrl ?? null,
          validationStatus: "valid",
          detectedAuth: auth as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.endpoint.deleteMany({ where: { projectId } });
      if (endpoints.length > 0) {
        await tx.endpoint.createMany({
          data: endpoints.map((e) => ({
            projectId,
            method: e.method,
            path: e.path,
            operationId: e.operationId ?? null,
            summary: e.summary ?? null,
            description: e.description ?? null,
            tag: e.tags[0] ?? null,
            requestSchema: e.requestSchema
              ? (toCycleSafe(e.requestSchema) as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            responseSchema: e.responseSchema
              ? (toCycleSafe(e.responseSchema) as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            authRequired: e.authRequired,
            deprecated: e.deprecated,
          })),
        });
      }

      await tx.project.update({
        where: { id: projectId },
        data: { status: "ENDPOINTS_ANALYZED" },
      });
      return created;
    });

    return {
      specId: spec.id,
      title: validation.title,
      openapiVersion: validation.openapiVersion,
      endpointCount: endpoints.length,
      auth,
    };
  }

  getLatestSpec(projectId: string) {
    return this.prisma.apiSpec.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  listEndpoints(projectId: string) {
    return this.prisma.endpoint.findMany({
      where: { projectId },
      orderBy: [{ path: "asc" }, { method: "asc" }],
    });
  }

  private async recordInvalid(
    projectId: string,
    originalFileUrl: string,
    doc: Record<string, unknown> | null,
    errors: string[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.apiSpec.create({
        data: {
          projectId,
          originalFileUrl,
          parsedJson: doc ? (doc as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          validationStatus: "invalid",
          validationErrors: errors as unknown as Prisma.InputJsonValue,
        },
      }),
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: "SPEC_INVALID" },
      }),
    ]);
  }
}
