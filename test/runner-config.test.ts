import { defaultConfig } from 'lighthouse';
import { describe, expect, it } from 'vitest';
import {
  LIGHTHOUSE_CATEGORIES,
  REQUIRED_PERFORMANCE_AUDITS,
  computePerformanceSkipAudits,
} from '../src/runner.js';

// The suite runs against the installed Lighthouse version, so a major bump that
// removes one of the audits Pulse reads (or changes the `defaultConfig` export)
// fails here instead of silently returning zeroed metrics at audit time.
type SkipConfig = Parameters<typeof computePerformanceSkipAudits>[0];

describe('Lighthouse performance audit skip list', () => {
  const config = defaultConfig as unknown as SkipConfig;
  const perfAuditRefs: readonly { id?: string }[] | undefined = config?.categories?.performance?.auditRefs;
  const installedIds = new Set((perfAuditRefs ?? []).map((ref) => ref.id));

  it('runs the best-practices category for the console error audit', () => {
    expect(LIGHTHOUSE_CATEGORIES).toContain('performance');
    expect(LIGHTHOUSE_CATEGORIES).toContain('accessibility');
    expect(LIGHTHOUSE_CATEGORIES).toContain('best-practices');

    const bestPracticeIds = new Set(
      (config?.categories?.['best-practices']?.auditRefs ?? []).map((ref: { id?: string }) => ref.id),
    );
    expect(bestPracticeIds.has('errors-in-console')).toBe(true);
  });

  it('never skips the console error audit', () => {
    expect(computePerformanceSkipAudits(config)).not.toContain('errors-in-console');
  });

  it('exports a usable performance category', () => {
    expect(Array.isArray(perfAuditRefs)).toBe(true);
    expect(installedIds.size).toBeGreaterThan(0);
  });

  it('keeps every required audit in the installed performance category', () => {
    for (const id of REQUIRED_PERFORMANCE_AUDITS) {
      expect(installedIds.has(id), `${id} is missing from Lighthouse's performance category`).toBe(true);
    }
  });

  it('never skips a required audit and skips the rest', () => {
    const skipAudits = computePerformanceSkipAudits(config);

    expect(skipAudits.length).toBeGreaterThan(0);
    for (const id of REQUIRED_PERFORMANCE_AUDITS) {
      expect(skipAudits, `${id} must not be skipped`).not.toContain(id);
    }
    for (const id of skipAudits) {
      expect(installedIds.has(id), `${id} is not part of the installed performance category`).toBe(true);
    }
  });

  it('falls back to an empty skip list when the config shape is missing', () => {
    expect(computePerformanceSkipAudits(undefined)).toEqual([]);
    expect(computePerformanceSkipAudits({})).toEqual([]);
    expect(computePerformanceSkipAudits({ categories: {} })).toEqual([]);
  });
});
