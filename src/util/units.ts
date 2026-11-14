/**
 * Human-readable unit parsers.
 *
 * Each parser returns the original value when it cannot understand the input so
 * that the zod schema that follows reports a normal type error instead of a
 * confusing unit-specific one.
 */

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;

const DURATION = new RegExp(`^(${NUMBER})\\s*(ms|s|m)?$`, 'i');
const BYTES = new RegExp(`^(${NUMBER})\\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$`, 'i');
const PERCENT = new RegExp(`^(${NUMBER})\\s*%?$`, 'i');
const PLAIN_NUMBER = new RegExp(`^(${NUMBER})$`, 'i');

function finite(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a duration into milliseconds. Accepts `2500`, `"2500ms"`, `"2.5s"`. */
export function parseDuration(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = DURATION.exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  if (amount === null) return value;

  const unit = match[2] as string | undefined;
  switch (unit?.toLowerCase()) {
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60_000;
    case undefined:
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

  const match = BYTES.exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  if (amount === null) return value;

  const unit = match[2] as string | undefined;
  const key = (unit ?? 'b').toLowerCase();
  const multiplier = Object.hasOwn(BYTE_MULTIPLIERS, key) ? BYTE_MULTIPLIERS[key] : undefined;
  return multiplier === undefined ? value : amount * multiplier;
}

/** Parse a percentage. Accepts `10` and `"10%"`. */
export function parsePercent(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = PERCENT.exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  return amount ?? value;
}

/** Parse a CLS-style score. Accepts numbers and numeric strings. */
export function parseScore(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = PLAIN_NUMBER.exec(value.trim());
  if (!match) return value;

  const amount = finite(match[1]);
  return amount ?? value;
}

/** Parse a request/node count. Accepts numbers and numeric strings. */
export function parseCount(value: unknown): unknown {
  return parseScore(value);
}
