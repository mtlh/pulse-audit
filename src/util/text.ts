// The ESC control character is the prefix of the escape sequence, so this
// regex intentionally matches it.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/**
 * Right-pads a table cell. ANSI colour escapes are ignored when measuring the
 * visible width, so coloured and plain cells line up in the same column.
 */
export function padRight(value: string, width: number): string {
  const visible = value.replace(ANSI_ESCAPE, '');
  return value + ' '.repeat(Math.max(0, width - visible.length));
}

/** Shortens text to `width`, marking the cut with an ellipsis. */
export function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}
