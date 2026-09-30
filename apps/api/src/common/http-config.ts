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
 * HTTP-level app config shared by `main.ts` and the e2e tests. Call before
 * `init()`/`listen()`.
 *
 * - The JSON parser gets the raised limit (Nest then skips its 100 KB default).
 * - `X-Forwarded-For` is trusted only from a loopback peer. Browsers reach the
 *   API through the Next.js rewrite proxy on the same host (behind cloudflared
 *   in the demo), so without this every request looks like 127.0.0.1 and the
 *   per-IP rate limits collapse into one global bucket. Trusting only loopback
 *   means a client that talks to the API directly can't spoof its address.
 */
export function configureHttp(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT_BYTES });
  app.set("trust proxy", "loopback");
}
