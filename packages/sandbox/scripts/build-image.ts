/**
 * Pre-build the sandbox image (deploy/bootstrap step). Optional: the first
 * sandbox run builds it on demand, but pre-building keeps that first run fast.
 *
 *   pnpm --filter @unumcp/sandbox build-image
 */
import { ensureSandboxImage, SANDBOX_IMAGE } from "../src/image";

const result = await ensureSandboxImage((chunk) => process.stdout.write(chunk));
if (!result.ok) {
  console.error(`\nFailed to build ${SANDBOX_IMAGE}.`);
  process.exit(1);
}
console.log(`Sandbox image ready: ${SANDBOX_IMAGE}`);
