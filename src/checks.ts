import { formatDelta, formatPercent, formatValue, noteworthyReason } from './format.js';
import type { Check, Status } from './types.js';

/**
 * Presentation model shared by the terminal, Markdown and HTML reporters.
 *
 * Each reporter owns its markup but reads labels, values, budgets, deltas and
 * notes through this view, so the same check cannot render one number in the
 * terminal and another in the PR summary.
 */
export interface CheckView {
  check: Check;
  label: string;
  /** Formatted measured value. */
  value: string;
  /** Formatted budget, or an em dash when the rule has no ceiling. */
  budget: string;
  /** Formatted delta, or an em dash when there is no numeric comparison. */
  deltaText: string;
  deltaPctText: string;
  /** `+120ms (+8.0%)`, or an em dash. */
  deltaSummary: string;
  hasDelta: boolean;
  hasBaseline: boolean;
  /** `pass`, `WARN` or `FAIL`. */
  statusLabel: string;
  /** Explanation worth showing, or undefined for a routine pass. */
  note?: string;
}

export function checkView(check: Check): CheckView {
  const hasDelta = check.delta !== undefined;
  const deltaText = formatDelta(check.delta, check.format);
  const deltaPctText = formatPercent(check.deltaPct);

  return {
    check,
    label: check.label,
    value: check.formatted,
    budget: check.max === undefined ? '—' : formatValue(check.max, check.format),
    deltaText,
    deltaPctText,
    deltaSummary: hasDelta ? `${deltaText} (${deltaPctText})` : '—',
    hasDelta,
    hasBaseline: check.baseline !== undefined,
    statusLabel: check.status === 'pass' ? 'pass' : check.status.toUpperCase(),
    note: noteworthyReason(check),
  };
}

export function checkViews(checks: readonly Check[]): CheckView[] {
  return checks.map(checkView);
}

export interface CheckNote {
  label: string;
  reason: string;
}

/** Notes for the checks whose status alone would hide something important. */
export function checkNotes(checks: readonly Check[]): CheckNote[] {
  const notes: CheckNote[] = [];
  for (const check of checks) {
    const reason = noteworthyReason(check);
    if (reason !== undefined) notes.push({ label: check.label, reason });
  }
  return notes;
}

export interface CheckCounts {
  failed: number;
  warned: number;
  passed: number;
}

/** Counts by status; the report totals and per-entry summaries share this. */
export function countChecks(checks: readonly Check[]): CheckCounts {
  const counts: CheckCounts = { failed: 0, warned: 0, passed: 0 };
  for (const check of checks) counts[statusKey(check.status)] += 1;
  return counts;
}

function statusKey(status: Status): keyof CheckCounts {
  if (status === 'fail') return 'failed';
  if (status === 'warn') return 'warned';
  return 'passed';
}

/** Looks up one check by its stable metric id. */
export function findCheck(entry: { checks: readonly Check[] }, metric: string): Check | undefined {
  return entry.checks.find((check) => check.metric === metric);
}
