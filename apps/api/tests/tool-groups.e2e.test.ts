import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const ok = { "200": { description: "ok" } };
const id = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Groups", version: "1.0.0" },
  servers: [{ url: "https://api.groups.test" }],
  paths: {
    "/widgets": { get: { operationId: "listWidgets", tags: ["Widgets"], responses: ok } },
    "/widgets/{id}": {
      get: { operationId: "getWidget", tags: ["Widgets"], parameters: id, responses: ok },
      delete: { operationId: "deleteWidget", tags: ["Widgets"], parameters: id, responses: ok },
    },
    "/gadgets": { get: { operationId: "listGadgets", tags: ["Gadgets"], responses: ok } },
    "/orders/{id}": { get: { operationId: "getOrder", parameters: id, responses: ok } },
  },
});

interface Tool {
  name: string;
  group: string;
  enabled: boolean;
  riskLevel: string;
}

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

async function projectWithTools() {
  const email = `groups-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const server = app.getHttpServer();
  const reg = await request(server).post("/auth/register").send({ email, password: "password123" });
  const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
  const project = await request(server).post("/projects").set(auth).send({ name: "Groups" });
  await request(server).post(`/projects/${project.body.id}/spec/upload`).set(auth).send({ filename: "g.json", content: spec });
  const tools = (await request(server).post(`/projects/${project.body.id}/tools/propose`).set(auth)).body as Tool[];
  return { projectId: project.body.id as string, auth, tools };
}

const byName = (tools: Tool[]) => Object.fromEntries(tools.map((t) => [t.name, t]));

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  prisma = app.get(PrismaService);
  await app.init();
});

afterAll(async () => {
  for (const email of emails) await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  await app.close();
});

describe("tool groups", () => {
  it("puts each tool in its tag's group, or its first path segment's", async () => {
    const { tools } = await projectWithTools();
    const groups = Object.fromEntries(tools.map((t) => [t.name, t.group]));
    expect(groups).toEqual({
      list_widgets: "widgets",
      get_widget: "widgets",
      delete_widget: "widgets",
      list_gadgets: "gadgets",
      get_order: "orders",
    });
  });

  it("turns a group off, and on again without its high-risk tools", async () => {
    const { projectId, auth, tools } = await projectWithTools();
    expect(byName(tools).delete_widget).toMatchObject({ riskLevel: "high", enabled: false });
    const server = app.getHttpServer();

    const off = await request(server).post(`/projects/${projectId}/tools/groups/widgets`).set(auth).send({ enabled: false });
    expect(off.status).toBe(200);
    const afterOff = byName(off.body);
    expect([afterOff.list_widgets!.enabled, afterOff.get_widget!.enabled, afterOff.delete_widget!.enabled]).toEqual([false, false, false]);
    expect(afterOff.list_gadgets!.enabled).toBe(true);

    const on = byName((await request(server).post(`/projects/${projectId}/tools/groups/widgets`).set(auth).send({ enabled: true })).body);
    expect([on.list_widgets!.enabled, on.get_widget!.enabled]).toEqual([true, true]);
    expect(on.delete_widget!.enabled).toBe(false);
  });

  it("refuses an unknown group, a missing flag, and a plan already approved", async () => {
    const { projectId, auth } = await projectWithTools();
    const server = app.getHttpServer();
    const group = (name: string, body: object) =>
      request(server).post(`/projects/${projectId}/tools/groups/${name}`).set(auth).send(body);

    expect((await group("nope", { enabled: true })).status).toBe(404);
    expect((await group("widgets", {})).status).toBe(400);
    await request(server).post(`/projects/${projectId}/tools/approve`).set(auth);
    expect((await group("widgets", { enabled: false })).status).toBe(409);
  });
});
