import { BadRequestException, Injectable } from "@nestjs/common";
import {
  dereferenceSpec,
  detectAuth,
  extractEndpoints,
  parseSpec,
  toCycleSafe,
  validateSpec,
  type DetectedAuth,
  type ExtractedEndpoint,
  type SpecValidation,
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
    const { doc, validation } = await this.parseAndValidate(projectId, originalFileUrl, content);

    const deref = await dereferenceSpec(doc);
    const endpoints = extractEndpoints(deref);
    const auth = detectAuth(deref);
    const spec = await this.saveValidSpec(projectId, originalFileUrl, doc, validation, endpoints, auth);

    return {
      specId: spec.id,
      title: validation.title,
      openapiVersion: validation.openapiVersion,
      endpointCount: endpoints.length,
      auth,
    };
  }

  /** Parse and validate the upload; a spec that fails either is recorded as invalid and refused. */
  private async parseAndValidate(projectId: string, originalFileUrl: string, content: string) {
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
    return { doc: parsed.doc, validation };
  }

  /** Store a valid spec with its endpoints (replacing the previous ones) and advance the project. */
  private saveValidSpec(
    projectId: string,
    originalFileUrl: string,
    doc: Record<string, unknown>,
    validation: SpecValidation,
    endpoints: ExtractedEndpoint[],
    auth: DetectedAuth,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.apiSpec.create({
        data: {
          projectId,
          originalFileUrl,
          parsedJson: doc as unknown as Prisma.InputJsonValue,
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
        await tx.endpoint.createMany({ data: endpoints.map((e) => toEndpointRow(projectId, e)) });
      }

      await tx.project.update({
        where: { id: projectId },
        data: { status: "ENDPOINTS_ANALYZED" },
      });
      return created;
    });
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

/** One extracted endpoint as an `Endpoint` row; schemas are stored cycle-safe. */
function toEndpointRow(projectId: string, e: ExtractedEndpoint) {
  const json = (schema: unknown) =>
    schema ? (toCycleSafe(schema) as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
  return {
    projectId,
    method: e.method,
    path: e.path,
    operationId: e.operationId ?? null,
    summary: e.summary ?? null,
    description: e.description ?? null,
    tag: e.tags[0] ?? null,
    requestSchema: json(e.requestSchema),
    responseSchema: json(e.responseSchema),
    authRequired: e.authRequired,
    deprecated: e.deprecated,
  };
}
