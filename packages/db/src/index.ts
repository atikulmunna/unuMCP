import { PrismaPg } from "@prisma/adapter-pg";
import type { Prisma } from "@prisma/client";

export * from "@prisma/client";

/**
 * Options for every PrismaClient (the API, tests, scripts). Prisma 7 reaches
 * Postgres through the `pg` driver adapter. The 5 s connect timeout is the
 * one Prisma 6 had built in; `pg` would otherwise wait forever for a database
 * that is down.
 */
export function prismaClientOptions(
  connectionString = process.env.DATABASE_URL,
): Prisma.PrismaClientOptions {
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  return { adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }) };
}
