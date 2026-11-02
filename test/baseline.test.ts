import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baselineKey,
  comparableBaseline,
  mergeBaseline,
  pruneBaseline,
  readBaseline,
} from '../src/baseline.js';
import type { AuditMetrics, AuditResult, BaselineFile } from '../src/types.js';

function metrics(overrides: Partial<AuditMetrics> = {}): AuditMetrics {
  return {
    lcp: 1600,
    cls: 0.01,
    tbt: 50,
    fcp: 1200,
    ttfb: 300,
    js: 100_000,
    css: 20_000,
    fonts: 30_000,
    images: 200_000,
    total: 400_000,
    requests: 3,
    thirdPartyBytes: 0,
    thirdPartyRequests: 0,
    violations: 2,
    ...overrides,
  };
}

function result(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-11-02T00:00:00.000Z',
    lighthouseVersion: '12.6.0',
    metrics: metrics(),
    heaviest: [],
    violations: [],
    ...overrides,
  };
}

async function withTempFile(
  name: string,
  contents: unknown,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-baseline-'));
  try {
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('baseline', () => {
  it('migrates a v1 file to v2 keys using each result preset', async () => {
    const desktop = result({ preset: 'desktop' });
    const fallback = { ...result({ url: 'https://example.com/legacy' }), preset: undefined };

    const v1 = {
      version: 1,
      results: {
        'https://example.com/': desktop,
        'https://example.com/legacy': fallback,
      },
    };

    await withTempFile('baseline.json', v1, async (path) => {
      const file = await readBaseline(path);
      expect(file.version).toBe(2);
      expect(Object.keys(file.results).sort()).toEqual([
        baselineKey('desktop', 'https://example.com/'),
        baselineKey('mobile', 'https://example.com/legacy'),
      ]);
      expect(file.results[baselineKey('desktop', 'https://example.com/')]?.preset).toBe('desktop');
      expect(file.results[baselineKey('mobile', 'https://example.com/legacy')]?.url).toBe(
        'https://example.com/legacy',
      );
    });
  });

  it('rejects an unsupported baseline version', async () => {
    await withTempFile('baseline.json', { version: 3, results: {} }, async (path) => {
      await expect(readBaseline(path)).rejects.toThrow(/Unsupported baseline format/);
    });
  });

  it('keeps mobile and desktop keys side by side after merge', () => {
    const file: BaselineFile = { version: 2, results: {} };
    const mobile = result({ preset: 'mobile' });
    const desktop = result({ preset: 'desktop' });

    const merged = mergeBaseline(file, [mobile, desktop]);

    expect(merged.version).toBe(2);
    expect(Object.keys(merged.results).sort()).toEqual([
      baselineKey('desktop', 'https://example.com/'),
      baselineKey('mobile', 'https://example.com/'),
    ]);
    expect(merged.results[baselineKey('mobile', 'https://example.com/')]?.preset).toBe('mobile');
    expect(merged.results[baselineKey('desktop', 'https://example.com/')]?.preset).toBe('desktop');
  });

  it('prunes to only the requested keys without mutating the input', () => {
    const mobileKey = baselineKey('mobile', 'https://example.com/');
    const desktopKey = baselineKey('desktop', 'https://example.com/');
    const file: BaselineFile = {
      version: 2,
      results: {
        [mobileKey]: result({ preset: 'mobile' }),
        [desktopKey]: result({ preset: 'desktop' }),
        [baselineKey('mobile', 'https://example.com/other')]: result({
          url: 'https://example.com/other',
        }),
      },
    };

    const pruned = pruneBaseline(file, new Set([mobileKey]));

    expect(Object.keys(pruned.results)).toEqual([mobileKey]);
    expect(pruned.results[mobileKey]?.preset).toBe('mobile');
    expect(Object.keys(file.results)).toHaveLength(3);
  });

  it('rejects a different preset or run count', () => {
    const baseline = result({ preset: 'mobile', runs: 3 });

    expect(comparableBaseline(baseline, result({ preset: 'desktop', runs: 3 }))).toBeNull();
    expect(comparableBaseline(baseline, result({ preset: 'mobile', runs: 5 }))).toBeNull();
  });

  it('accepts a different Lighthouse patch but rejects a different major', () => {
    const baseline = result({ lighthouseVersion: '12.6.0' });

    expect(comparableBaseline(baseline, result({ lighthouseVersion: '12.9.1' }))).toBe(baseline);
    expect(comparableBaseline(baseline, result({ lighthouseVersion: '13.0.0' }))).toBeNull();
    expect(comparableBaseline(baseline, result({ lighthouseVersion: '11.9.0' }))).toBeNull();
  });
});
