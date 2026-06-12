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

function uniqueEmail(tag: string): string {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  return email;
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

describe("auth (P1-4)", () => {
  it("registers a user and returns a token", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: uniqueEmail("reg"), password: "password123", name: "Reg" });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toContain("reg-");
  });

  it("rejects a weak password", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: uniqueEmail("weak"), password: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate registration", async () => {
    const email = uniqueEmail("dup");
    await request(app.getHttpServer()).post("/auth/register").send({ email, password: "password123" });
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password: "password123" });
    expect(res.status).toBe(409);
  });

  it("logs in with valid credentials and rejects bad ones", async () => {
    const email = uniqueEmail("login");
    await request(app.getHttpServer()).post("/auth/register").send({ email, password: "password123" });

    const ok = await request(app.getHttpServer()).post("/auth/login").send({ email, password: "password123" });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();

    const bad = await request(app.getHttpServer()).post("/auth/login").send({ email, password: "wrongpass" });
    expect(bad.status).toBe(401);
  });

  it("protects /auth/me — 401 without token, 200 with", async () => {
    const email = uniqueEmail("me");
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password: "password123" });
    const token = reg.body.accessToken;

    expect((await request(app.getHttpServer()).get("/auth/me")).status).toBe(401);

    const me = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });
});

describe("object-level authorization (P1-5, FR-002b)", () => {
  async function makeUser(tag: string) {
    const email = uniqueEmail(tag);
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password: "password123" });
    return { token: res.body.accessToken as string, userId: res.body.user.id as string };
  }

  it("lets an owner create and read their project", async () => {
    const a = await makeUser("owner");
    const created = await request(app.getHttpServer())
      .post("/projects")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "Mine" });
    expect(created.status).toBe(201);

    const fetched = await request(app.getHttpServer())
      .get(`/projects/${created.body.id}`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.name).toBe("Mine");
  });

  it("returns 404 (not 403) when another user accesses the project", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    const created = await request(app.getHttpServer())
      .post("/projects")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "Secret" });

    const asB = await request(app.getHttpServer())
      .get(`/projects/${created.body.id}`)
      .set("Authorization", `Bearer ${b.token}`);
    expect(asB.status).toBe(404);
  });

  it("requires auth to access projects", async () => {
    const res = await request(app.getHttpServer()).get("/projects/some-id");
    expect(res.status).toBe(401);
  });
});
