import type { Check } from './types.js';

export type ValueFormat = 'ms' | 'score' | 'bytes' | 'count';

export function formatValue(value: number, format: ValueFormat): string {
  if (!Number.isFinite(value)) return '—';
  switch (format) {
    case 'ms':
      return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
    case 'score':
      return value.toFixed(3);
    case 'bytes':
      return formatBytes(value);
    case 'count':
      return String(Math.round(value));
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDelta(delta: number | undefined, format: ValueFormat): string {
  if (delta === undefined || !Number.isFinite(delta)) return '—';
  const sign = delta > 0 ? '+' : '';
  if (format === 'ms') {
    return `${sign}${delta >= 1000 || delta <= -1000 ? `${(delta / 1000).toFixed(2)}s` : `${Math.round(delta)}ms`}`;
  }
  if (format === 'bytes') {
    // formatBytes only renders positive values, so the minus has to be added
    // explicitly or an improvement reads as a regression in the report.
    return `${delta < 0 ? '-' : sign}${formatBytes(Math.abs(delta))}`;
  }
  if (format === 'score') {
    return `${sign}${delta.toFixed(3)}`;
  }
  return `${sign}${Math.round(delta)}`;
}

/** `1.48–1.61s` rather than `1.48s–1.61s` when both ends share a unit. */
export function formatRange(min: number, max: number, format: ValueFormat): string {
  const minText = formatValue(min, format);
  const maxText = formatValue(max, format);
  if (format === 'ms' || format === 'bytes') {
    const minParts = /^([\d.]+)( ?[A-Za-z]+)$/.exec(minText);
    const maxParts = /^([\d.]+)( ?[A-Za-z]+)$/.exec(maxText);
    if (minParts && maxParts && minParts[2] === maxParts[2]) {
      return `${minParts[1]}–${maxText}`;
    }
  }
  return `${minText}–${maxText}`;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string,
  );
}

/**
 * Returns the explanation for a check when the status alone would hide
 * something important: a failure, a warning, the ratchet ("over max but not a
 * regression") or an inactive gate with no baseline. Routine passes return
 * undefined so the tables stay quiet.
 */
export function noteworthyReason(check: Check): string | undefined {
  if (check.status !== 'pass') return check.reason;
  if (check.reason.startsWith('within ')) return undefined;
  if (check.reason === 'no new violations') return undefined;
  return check.reason;
}
