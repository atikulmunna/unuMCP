import { defineConfig } from "prisma/config";

// The Prisma CLI's settings. The connection string comes from DATABASE_URL in
// the environment (the CLI does not read .env files); `prisma generate` needs
// no database, so a missing URL only fails the commands that connect.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
