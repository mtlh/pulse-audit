/**
 * Human-readable unit parsers.
 *
 * Each parser returns the original value when it cannot understand the input so
 * that the zod schema that follows reports a normal type error instead of a
 * confusing unit-specific one.
 */

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;

function finite(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a duration into milliseconds. Accepts `2500`, `"2500ms"`, `"2.5s"`. */
export function parseDuration(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = new RegExp(`^(${NUMBER})\\s*(ms|s|m)?$`, 'i').exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  if (amount === null) return value;

  switch (match[2]?.toLowerCase()) {
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60_000;
    default:
      return amount;
  }
}

const BYTE_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/** Parse a byte size. Accepts `250000`, `"250kb"`, `"1.5mb"` (1024 multiplier). */
export function parseBytes(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = new RegExp(`^(${NUMBER})\\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$`, 'i').exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  if (amount === null) return value;

  const multiplier = BYTE_MULTIPLIERS[match[2]?.toLowerCase() ?? 'b'];
  return multiplier === undefined ? value : amount * multiplier;
}

/** Parse a percentage. Accepts `10` and `"10%"`. */
export function parsePercent(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = new RegExp(`^(${NUMBER})\\s*%?$`, 'i').exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  return amount === null ? value : amount;
}

/** Parse a CLS-style score. Accepts numbers and numeric strings. */
export function parseScore(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = new RegExp(`^(${NUMBER})$`, 'i').exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  return amount === null ? value : amount;
}

/** Parse a request/node count. Accepts numbers and numeric strings. */
export function parseCount(value: unknown): unknown {
  return parseScore(value);
}
