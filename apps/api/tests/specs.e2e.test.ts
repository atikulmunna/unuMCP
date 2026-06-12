import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

const validSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Demo API", version: "1.0.0" },
  servers: [{ url: "https://api.demo.test" }],
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
          },
        },
      },
    },
    "/users": {
      post: {
        operationId: "createUser",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/NewUser" } } },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
  components: {
    schemas: {
      User: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      NewUser: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
});

const securedSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Secured API", version: "1.0.0" },
  servers: [{ url: "https://api.secured.test" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/me": { get: { operationId: "getMe", responses: { "200": { description: "ok" } } } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
  },
});

const invalidSpec = JSON.stringify({ openapi: "3.0.3", info: { title: "x", version: "1" } });

async function makeUser(tag: string): Promise<string> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const res = await request(app.getHttpServer())
    .post("/auth/register")
    .send({ email, password: "password123" });
  return res.body.accessToken;
}

async function makeProject(token: string, name = "P"): Promise<string> {
  const res = await request(app.getHttpServer())
    .post("/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name });
  return res.body.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  prisma = app.get(PrismaService);
  await app.init();
});

afterAll(async () => {
  for (const email of emails) {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await app.close();
});

describe("spec upload pipeline (P1-7/8/9)", () => {
  it("uploads a valid spec, extracts endpoints, and advances project status", async () => {
    const token = await makeUser("spec");
    const projectId = await makeProject(token);
    const auth = { Authorization: `Bearer ${token}` };

    const upload = await request(app.getHttpServer())
      .post(`/projects/${projectId}/spec/upload`)
      .set(auth)
      .send({ filename: "demo.json", content: validSpec });
    expect(upload.status).toBe(201);
    expect(upload.body.endpointCount).toBe(2);
    expect(upload.body.title).toBe("Demo API");

    const spec = await request(app.getHttpServer()).get(`/projects/${projectId}/spec`).set(auth);
    expect(spec.body.validationStatus).toBe("valid");
    expect(spec.body.openapiVersion).toBe("3.0.3");

    const endpoints = await request(app.getHttpServer())
      .get(`/projects/${projectId}/endpoints`)
      .set(auth);
    expect(endpoints.body).toHaveLength(2);
    const getUser = endpoints.body.find((e: any) => e.operationId === "getUser");
    // $ref was resolved before persisting.
    expect(getUser.responseSchema.properties.id.type).toBe("string");

    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("ENDPOINTS_ANALYZED");

    // F-1: this spec declares no securitySchemes, so auth is assumed and the user must configure.
    expect(upload.body.auth.assumed).toBe(true);
    expect(upload.body.auth.needsUserConfig).toBe(true);
    expect(spec.body.detectedAuth.needsUserConfig).toBe(true);
  });

  it("detects a declared bearer scheme and persists it (P2-11)", async () => {
    const token = await makeUser("secured");
    const projectId = await makeProject(token);
    const auth = { Authorization: `Bearer ${token}` };

    const upload = await request(app.getHttpServer())
      .post(`/projects/${projectId}/spec/upload`)
      .set(auth)
      .send({ filename: "secured.json", content: securedSpec });
    expect(upload.status).toBe(201);
    expect(upload.body.auth.required).toBe(true);
    expect(upload.body.auth.needsUserConfig).toBe(false);
    expect(upload.body.auth.schemes).toEqual([
      { id: "bearerAuth", type: "http", httpScheme: "bearer" },
    ]);

    const spec = await request(app.getHttpServer()).get(`/projects/${projectId}/spec`).set(auth);
    expect(spec.body.detectedAuth.schemes[0].httpScheme).toBe("bearer");
  });

  it("rejects an invalid spec with friendly errors and marks the project", async () => {
    const token = await makeUser("invalid");
    const projectId = await makeProject(token);
    const auth = { Authorization: `Bearer ${token}` };

    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/spec/upload`)
      .set(auth)
      .send({ filename: "bad.json", content: invalidSpec });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.errors)).toContain("paths");

    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("SPEC_INVALID");
  });

  it("rejects unsupported file extensions", async () => {
    const token = await makeUser("ext");
    const projectId = await makeProject(token);
    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/spec/upload`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ filename: "spec.txt", content: validSpec });
    expect(res.status).toBe(400);
  });

  it("enforces ownership on spec routes (404 for non-owner)", async () => {
    const owner = await makeUser("owner");
    const other = await makeUser("other");
    const projectId = await makeProject(owner);

    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/endpoints`)
      .set({ Authorization: `Bearer ${other}` });
    expect(res.status).toBe(404);
  });
});

describe("project CRUD (P1-6)", () => {
  it("updates and deletes a project", async () => {
    const token = await makeUser("crud");
    const projectId = await makeProject(token, "Before");
    const auth = { Authorization: `Bearer ${token}` };

    const patched = await request(app.getHttpServer())
      .patch(`/projects/${projectId}`)
      .set(auth)
      .send({ name: "After" });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("After");

    const del = await request(app.getHttpServer()).delete(`/projects/${projectId}`).set(auth);
    expect(del.status).toBe(204);

    const gone = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(gone.status).toBe(404);
  });
});
