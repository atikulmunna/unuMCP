import type { NestExpressApplication } from "@nestjs/platform-express";
import { MAX_SPEC_CHARS } from "../specs/schemas";

/**
 * JSON body limit in bytes. Express defaults to 100 KB, which rejected almost
 * every real spec (GitHub's is ~12 MB) long before the 25 MB spec cap applied.
 * The spec travels as a JSON-escaped string, and escaping (`\"`, `\n`) can
 * roughly double its size, so the transport limit is twice the cap; zod still
 * enforces the real cap on the decoded content.
 */
export const JSON_BODY_LIMIT_BYTES = 2 * MAX_SPEC_CHARS;

/**
 * Register the JSON parser with the raised limit. Call before `init()`/`listen()`:
 * Nest then skips its default 100 KB parser.
 */
export function configureBodyParser(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT_BYTES });
}
