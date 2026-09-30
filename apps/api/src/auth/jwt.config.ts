/** HS256 needs a key of at least 256 bits (RFC 7518 §3.2): 32 characters. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * The JWT signing secret from env. There is deliberately no fallback: a default
 * secret would let anyone forge a token for any user, so a missing or weak
 * secret stops the API from booting instead of silently running insecure.
 */
export function jwtSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to apps/api/.env.",
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`,
    );
  }
  return secret;
}
