import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  budgetsFromResult,
  configSchema,
  defaultConfig,
  resolveTargets,
  writeConfig,
} from '../src/config.js';
import type { AuditMetrics, AuditResult } from '../src/types.js';

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

function result(overrides: Partial<AuditMetrics> = {}): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 1,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: metrics(overrides),
    heaviest: [],
    violations: [],
  };
}

describe('config', () => {
  it('round-trips the default config', () => {
    const parsed = configSchema.parse(defaultConfig(['https://example.com/']));
    expect(parsed.preset).toBe('mobile');
    expect(parsed.runs).toBe(3);
    expect(parsed.strict).toBe(false);
    expect(parsed.retries).toBe(1);
    expect(parsed.timeoutMs).toBe(120_000);
    expect(parsed.report.outDir).toBe('.pulse');
    expect(parsed.budgets.lcp?.max).toBe(2500);
    expect(parsed.budgets.fcp?.max).toBe(1800);
    expect(parsed.budgets.thirdPartyRequests?.max).toBe(20);
    expect(parsed.budgets.a11y?.maxNewByImpact).toEqual({ critical: 0, serious: 0 });
  });

  it('applies defaults to a minimal config', () => {
    const parsed = configSchema.parse({ urls: ['https://example.com/'] });
    expect(parsed.preset).toBe('mobile');
    expect(parsed.runs).toBe(3);
    expect(parsed.strict).toBe(false);
    expect(parsed.retries).toBe(1);
    expect(parsed.timeoutMs).toBe(120_000);
    expect(parsed.report.outDir).toBe('.pulse');
  });

  it('rejects an invalid preset', () => {
    const parsed = configSchema.safeParse({ urls: ['https://example.com/'], preset: 'tablet' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-URL', () => {
    const parsed = configSchema.safeParse({ urls: ['not-a-url'] });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown keys instead of silently ignoring typos', () => {
    const parsed = configSchema.safeParse({ urls: ['https://example.com/'], budgest: {} });
    expect(parsed.success).toBe(false);
  });

  it('normalizes readable units', () => {
    const parsed = configSchema.parse({
      urls: ['https://example.com/'],
      budgets: {
        lcp: { max: '2.5s' },
        js: { max: '250kb' },
        total: { max: '1.5mb' },
        requests: { max: '90', regression: '10%' },
      },
    });

    expect(parsed.budgets.lcp?.max).toBe(2500);
    expect(parsed.budgets.js?.max).toBe(256_000);
    expect(parsed.budgets.total?.max).toBe(1_572_864);
    expect(parsed.budgets.requests?.max).toBe(90);
    expect(parsed.budgets.requests?.regression).toBe(10);
  });

  it('rejects a metric rule with neither max nor regression', () => {
    const parsed = configSchema.safeParse({
      urls: ['https://example.com/'],
      budgets: { lcp: { severity: 'warn' } },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /max or regression/.test(issue.message))).toBe(true);
    }
  });

  it('rejects an a11y rule with no gate', () => {
    expect(
      configSchema.safeParse({
        urls: ['https://example.com/'],
        budgets: { a11y: { severity: 'warn' } },
      }).success,
    ).toBe(false);

    expect(
      configSchema.safeParse({
        urls: ['https://example.com/'],
        budgets: { a11y: { maxNewByImpact: {} } },
      }).success,
    ).toBe(false);
  });
});

describe('resolveTargets', () => {
  it('deep-merges per-URL budgets over globals and keeps sibling rules', () => {
    const config = configSchema.parse({
      urls: [
        'https://example.com/',
        {
          url: 'https://example.com/app',
          budgets: {
            lcp: { max: '3s' },
            a11y: { maxNew: 2, maxNewByImpact: { serious: 1 } },
          },
        },
      ],
      budgets: {
        lcp: { max: 2500, regression: 10 },
        js: { max: '250kb' },
        a11y: { maxViolations: 10, maxNew: 0, maxNewByImpact: { critical: 0 } },
      },
    });

    const [home, app] = resolveTargets(config);

    expect(home?.urls).toEqual(['https://example.com/']);
    expect(home?.budgets.lcp).toEqual({ max: 2500, regression: 10 });
    expect(app?.urls).toEqual(['https://example.com/app']);
    expect(app?.budgets.lcp).toEqual({ max: 3000, regression: 10 });
    expect(app?.budgets.js).toEqual({ max: 256_000 });
    expect(app?.budgets.a11y).toEqual({
      maxViolations: 10,
      maxNew: 2,
      maxNewByImpact: { critical: 0, serious: 1 },
    });
  });

  it('applies page preset and runs over the global values', () => {
    const config = configSchema.parse({
      preset: 'mobile',
      runs: 3,
      urls: ['https://example.com/', { url: 'https://example.com/app', preset: 'desktop', runs: 5 }],
    });

    const [home, app] = resolveTargets(config);
    expect(home?.preset).toBe('mobile');
    expect(home?.runs).toBe(3);
    expect(app?.preset).toBe('desktop');
    expect(app?.runs).toBe(5);
  });

  it('keeps strict, retries and timeout on resolved configs', () => {
    const config = configSchema.parse({
      urls: ['https://example.com/'],
      strict: true,
      retries: 4,
      timeoutMs: 30_000,
    });

    const [resolved] = resolveTargets(config);
    expect(resolved?.strict).toBe(true);
    expect(resolved?.retries).toBe(4);
    expect(resolved?.timeoutMs).toBe(30_000);
  });
});

describe('budgetsFromResult', () => {
  it('adds the documented headroom to a measured page', () => {
    const budgets = budgetsFromResult(result());

    expect(budgets.lcp?.max).toBe(2100);
    expect(budgets.cls?.max).toBe(0.05);
    expect(budgets.tbt?.max).toBe(200);
    expect(budgets.fcp?.max).toBe(1800);
    expect(budgets.ttfb?.max).toBe(800);
    expect(budgets.js?.max).toBe(120832);
    expect(budgets.css?.max).toBe(102400);
    expect(budgets.fonts?.max).toBe(307200);
    expect(budgets.images?.max).toBe(240640);
    expect(budgets.total?.max).toBe(1_572_864);
    expect(budgets.requests?.max).toBe(20);
    expect(budgets.thirdPartyBytes).toEqual({ max: 0, regression: 10, severity: 'warn' });
    expect(budgets.thirdPartyRequests).toEqual({ max: 0, regression: 10, severity: 'warn' });
    expect(budgets.a11y).toEqual({
      maxViolations: 2,
      maxNew: 0,
      maxNewByImpact: { critical: 0, serious: 0 },
    });
  });

  it('adds headroom for measured third-party and new metrics', () => {
    const budgets = budgetsFromResult(
      result({
        fcp: 2500,
        ttfb: 900,
        css: 120_000,
        fonts: 400_000,
        total: 2_000_000,
        thirdPartyBytes: 100_000,
        thirdPartyRequests: 4,
      }),
    );

    expect(budgets.fcp?.max).toBe(3000);
    expect(budgets.ttfb?.max).toBe(1100);
    expect(budgets.css?.max).toBe(144_384);
    expect(budgets.fonts?.max).toBe(480_256);
    expect(budgets.total?.max).toBe(2_400_256);
    expect(budgets.thirdPartyBytes?.max).toBe(307_200);
    expect(budgets.thirdPartyRequests?.max).toBe(20);
  });

  it('keeps floors so a tiny page does not get an unhittable budget', () => {
    const budgets = budgetsFromResult(
      result({
        lcp: 100,
        fcp: 100,
        ttfb: 100,
        js: 1000,
        css: 1000,
        fonts: 1000,
        images: 1000,
        total: 1000,
        requests: 1,
        violations: 0,
      }),
    );

    expect(budgets.lcp?.max).toBe(1000);
    expect(budgets.fcp?.max).toBe(1800);
    expect(budgets.ttfb?.max).toBe(800);
    expect(budgets.js?.max).toBe(50_000);
    expect(budgets.css?.max).toBe(102_400);
    expect(budgets.fonts?.max).toBe(307_200);
    expect(budgets.images?.max).toBe(100_000);
    expect(budgets.total?.max).toBe(1_572_864);
    expect(budgets.requests?.max).toBe(20);
    expect(budgets.a11y?.maxViolations).toBe(0);
  });
});

describe('writeConfig', () => {
  it('writes pages with no overrides as plain URL strings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-config-'));

    try {
      const path = join(dir, '.pulse.json');
      await writeConfig(path, {
        ...defaultConfig(['https://example.com/']),
        urls: [
          'https://example.com/',
          { url: 'https://example.com/app', preset: 'desktop', budgets: { lcp: { max: 3000 } } },
          { url: 'https://example.com/bare', preset: undefined, runs: undefined, budgets: {} },
        ],
      });

      const raw = JSON.parse(await readFile(path, 'utf8')) as {
        urls: Array<string | Record<string, unknown>>;
      };
      expect(raw.urls[0]).toBe('https://example.com/');
      expect(raw.urls[1]).toMatchObject({
        url: 'https://example.com/app',
        preset: 'desktop',
        budgets: { lcp: { max: 3000 } },
      });
      expect(raw.urls[2]).toBe('https://example.com/bare');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
