import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { A11yBudget, AuditResult, BudgetRule, BudgetSet, PageTarget, PulseConfig } from './types.js';
import { parseBytes, parseCount, parseDuration, parsePercent, parseScore } from './util/units.js';

type UnitParser = (value: unknown) => unknown;
type MetricKey = Exclude<keyof BudgetSet, 'a11y'>;

const METRIC_KEYS: MetricKey[] = [
  'lcp',
  'cls',
  'tbt',
  'fcp',
  'ttfb',
  'js',
  'css',
  'fonts',
  'images',
  'total',
  'requests',
  'thirdPartyBytes',
  'thirdPartyRequests',
];

function metricBudgetSchema(parseMax: UnitParser) {
  return z
    .object({
      max: z.preprocess(parseMax, z.number().nonnegative()).optional(),
      regression: z.preprocess(parsePercent, z.number().nonnegative().max(100)).optional(),
      severity: z.enum(['error', 'warn']).optional(),
    })
    .strict()
    .refine((rule) => rule.max !== undefined || rule.regression !== undefined, {
      message: 'A budget rule must set max or regression.',
    });
}

const countSchema = z.preprocess(parseCount, z.number().int().nonnegative());

const impactBudgetSchema = z
  .object({
    critical: countSchema.optional(),
    serious: countSchema.optional(),
    moderate: countSchema.optional(),
    minor: countSchema.optional(),
  })
  .strict();

const a11yBudgetSchema = z
  .object({
    severity: z.enum(['error', 'warn']).optional(),
    maxViolations: countSchema.optional(),
    maxNew: countSchema.optional(),
    maxNewByImpact: impactBudgetSchema.optional(),
    ignoreRules: z.array(z.string()).optional(),
  })
  .strict()
  .refine(
    (rule) =>
      rule.maxViolations !== undefined ||
      rule.maxNew !== undefined ||
      (rule.maxNewByImpact !== undefined &&
        Object.values(rule.maxNewByImpact).some((value) => value !== undefined)),
    {
      message: 'An accessibility budget must set maxViolations, maxNew or maxNewByImpact.',
    },
  );

const budgetsSchema = z
  .object({
    lcp: metricBudgetSchema(parseDuration).optional(),
    cls: metricBudgetSchema(parseScore).optional(),
    tbt: metricBudgetSchema(parseDuration).optional(),
    fcp: metricBudgetSchema(parseDuration).optional(),
    ttfb: metricBudgetSchema(parseDuration).optional(),
    js: metricBudgetSchema(parseBytes).optional(),
    css: metricBudgetSchema(parseBytes).optional(),
    fonts: metricBudgetSchema(parseBytes).optional(),
    images: metricBudgetSchema(parseBytes).optional(),
    total: metricBudgetSchema(parseBytes).optional(),
    requests: metricBudgetSchema(parseCount).optional(),
    thirdPartyBytes: metricBudgetSchema(parseBytes).optional(),
    thirdPartyRequests: metricBudgetSchema(parseCount).optional(),
    a11y: a11yBudgetSchema.optional(),
  })
  .strict();

const auditUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'URL must start with http:// or https://',
  });

const pageTargetSchema = z
  .object({
    url: auditUrlSchema,
    preset: z.enum(['mobile', 'desktop']).optional(),
    runs: z.number().int().min(1).max(10).optional(),
    budgets: budgetsSchema.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    preset: z.enum(['mobile', 'desktop']).default('mobile'),
    runs: z.number().int().min(1).max(10).default(3),
    strict: z.boolean().default(false),
    retries: z.number().int().nonnegative().default(1),
    timeoutMs: z.number().int().positive().default(120_000),
    urls: z.array(z.union([auditUrlSchema, pageTargetSchema])).min(1),
    budgets: budgetsSchema.default({}),
    report: z
      .object({
        outDir: z.string().min(1).default('.pulse'),
      })
      .strict()
      .default({}),
  })
  .strict();

export class PulseConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'PulseConfigError';
  }
}

export async function loadConfig(path = '.pulse.json'): Promise<PulseConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new PulseConfigError(`No config found at ${path}. Run "pulse init" first.`, path);
    }
    throw new PulseConfigError(`Could not read ${path}: ${(error as Error).message}`, path);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new PulseConfigError(`Invalid config at ${path}:\n${issues}`, path);
  }

  return parsed.data as PulseConfig;
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function mergeBudgetRule(base?: BudgetRule, override?: BudgetRule): BudgetRule | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...definedEntries(override) };
}

function mergeA11yBudget(base?: A11yBudget, override?: A11yBudget): A11yBudget | undefined {
  if (!base) return override;
  if (!override) return base;

  const merged: A11yBudget = { ...base, ...definedEntries(override) };
  const impacts = {
    ...(base.maxNewByImpact ?? {}),
    ...(override.maxNewByImpact ?? {}),
  };
  if (Object.keys(impacts).length > 0) merged.maxNewByImpact = impacts;
  return merged;
}

function mergeBudgets(base: BudgetSet, override?: Partial<BudgetSet>): BudgetSet {
  const merged: BudgetSet = { ...base };
  if (!override) return merged;

  for (const key of METRIC_KEYS) {
    const rule = mergeBudgetRule(base[key], override[key]);
    if (rule) merged[key] = rule;
  }

  if (override.a11y !== undefined) {
    const a11y = mergeA11yBudget(base.a11y, override.a11y);
    if (a11y) merged.a11y = a11y;
  }

  return merged;
}

/** Apply one URL's page-level overrides on top of the global config. */
export function resolvePageConfig(config: PulseConfig, target: string | PageTarget): PulseConfig {
  const page: PageTarget = typeof target === 'string' ? { url: target } : target;

  return {
    ...config,
    preset: page.preset ?? config.preset,
    runs: page.runs ?? config.runs,
    urls: [page.url],
    budgets: page.budgets ? mergeBudgets(config.budgets, page.budgets) : { ...config.budgets },
  };
}

/** One fully resolved config per URL, in declaration order. */
export function resolveTargets(config: PulseConfig): PulseConfig[] {
  return config.urls.map((target) => resolvePageConfig(config, target));
}

/** The URL from a config that `resolveTargets` has reduced to one target. */
export function targetUrl(page: PulseConfig): string {
  const target = page.urls[0];
  return typeof target === 'string' ? target : target.url;
}

export function budgetsFromResult(result: AuditResult): BudgetSet {
  const roundUp = (value: number, step: number): number => Math.ceil(value / step) * step;
  const metrics = result.metrics;

  const thirdPartyBytes =
    metrics.thirdPartyBytes === 0
      ? { max: 0, regression: 10, severity: 'warn' as const }
      : {
          max: Math.max(300 * 1024, roundUp(metrics.thirdPartyBytes * 1.2, 1024)),
          regression: 15,
          severity: 'warn' as const,
        };

  const thirdPartyRequests =
    metrics.thirdPartyRequests === 0
      ? { max: 0, regression: 10, severity: 'warn' as const }
      : {
          max: Math.max(20, metrics.thirdPartyRequests + 10),
          regression: 20,
          severity: 'warn' as const,
        };

  return {
    lcp: { max: Math.max(1000, roundUp(metrics.lcp + 500, 100)), regression: 10 },
    cls: { max: Math.max(0.05, Math.ceil((metrics.cls + 0.02) * 1000) / 1000), regression: 20 },
    tbt: { max: Math.max(200, roundUp(metrics.tbt + 100, 50)), severity: 'warn' },
    fcp: { max: Math.max(1800, roundUp(metrics.fcp + 500, 100)), regression: 15 },
    ttfb: { max: Math.max(800, roundUp(metrics.ttfb + 200, 50)), regression: 20, severity: 'warn' },
    js: { max: Math.max(50_000, roundUp(metrics.js * 1.2, 1024)), regression: 10 },
    css: {
      max: Math.max(100 * 1024, roundUp(metrics.css * 1.2, 1024)),
      regression: 10,
      severity: 'warn',
    },
    fonts: {
      max: Math.max(300 * 1024, roundUp(metrics.fonts * 1.2, 1024)),
      regression: 10,
      severity: 'warn',
    },
    images: { max: Math.max(100_000, roundUp(metrics.images * 1.2, 1024)), regression: 10 },
    total: {
      max: Math.max(1.5 * 1024 * 1024, roundUp(metrics.total * 1.2, 1024)),
      regression: 10,
      severity: 'warn',
    },
    requests: { max: Math.max(20, metrics.requests + 10), regression: 10 },
    thirdPartyBytes,
    thirdPartyRequests,
    // Existing debt becomes the ceiling; new debt is what a PR should block.
    a11y: {
      maxViolations: metrics.violations,
      maxNew: 0,
      maxNewByImpact: { critical: 0, serious: 0 },
    },
  };
}

export function defaultConfig(urls: string[]): PulseConfig {
  return {
    preset: 'mobile',
    runs: 3,
    strict: false,
    retries: 1,
    timeoutMs: 120_000,
    urls,
    budgets: {
      lcp: { max: 2500, regression: 10 },
      cls: { max: 0.05, regression: 20 },
      tbt: { max: 200, severity: 'warn' },
      fcp: { max: 1800, regression: 15 },
      ttfb: { max: 800, regression: 20, severity: 'warn' },
      js: { max: 250_000, regression: 10 },
      css: { max: 100 * 1024, regression: 10, severity: 'warn' },
      fonts: { max: 300 * 1024, regression: 10, severity: 'warn' },
      images: { max: 600_000, regression: 10 },
      total: { max: 1.5 * 1024 * 1024, regression: 10, severity: 'warn' },
      requests: { max: 90, regression: 10 },
      thirdPartyBytes: { max: 300 * 1024, regression: 15, severity: 'warn' },
      thirdPartyRequests: { max: 20, regression: 20, severity: 'warn' },
      a11y: {
        maxViolations: 0,
        maxNew: 0,
        maxNewByImpact: { critical: 0, serious: 0 },
      },
    },
    report: { outDir: '.pulse' },
  };
}

function serializeTarget(target: string | PageTarget): string | PageTarget {
  if (typeof target === 'string') return target;

  const page: PageTarget = { url: target.url };
  if (target.preset !== undefined) page.preset = target.preset;
  if (target.runs !== undefined) page.runs = target.runs;
  if (target.budgets !== undefined && Object.keys(target.budgets).length > 0) {
    page.budgets = target.budgets;
  }

  const hasOverrides =
    page.preset !== undefined ||
    page.runs !== undefined ||
    (page.budgets !== undefined && Object.keys(page.budgets).length > 0);

  return hasOverrides ? page : page.url;
}

export async function writeConfig(path: string, config: PulseConfig): Promise<void> {
  // JSON round-trip strips undefined keys so a page target with no overrides can
  // be written back as a plain URL string.
  const clean = JSON.parse(JSON.stringify(config)) as PulseConfig;
  const serializable: PulseConfig = {
    ...clean,
    urls: clean.urls.map(serializeTarget),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
}
