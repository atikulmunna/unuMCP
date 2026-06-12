export * from "@prisma/client";
import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Lazily-created shared PrismaClient for app/runtime use. */
export function getPrisma(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}
