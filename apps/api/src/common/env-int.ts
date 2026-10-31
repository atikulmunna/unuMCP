/**
 * An integer setting from the environment, clamped to [min, max]; the fallback
 * when it is unset or not a number.
 */
export function clampedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
