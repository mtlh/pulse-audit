import { z } from 'zod';
import { AUDIT_METRICS, API_METRICS, type BudgetMetricKey, type UnitParser } from './metrics.js';
import type {
  A11yBudget,
  ApiBudgetSet,
  ApiTarget,
  AuditResult,
  BudgetRule,
  BudgetSet,
  HttpMethod,
  PageTarget,
  PulseConfig,
  ResolvedApiTarget,
  ResolvedPageConfig,
} from './types.js';
import { DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS } from './util/defaults.js';
import { errorMessage, isEnoent } from './util/errors.js';
import { readJsonFile, writeJsonFile } from './util/files.js';
import { parseCount, parsePercent } from './util/units.js';

type MetricKey = BudgetMetricKey;

const METRIC_KEYS: MetricKey[] = AUDIT_METRICS.map((metric) => metric.key);

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

function metricBudgetShape(metrics: readonly { key: string; parse: UnitParser }[]): z.ZodRawShape {
  return Object.fromEntries(
    metrics.map((metric) => [metric.key, metricBudgetSchema(metric.parse).optional()]),
  );
}

const budgetsSchema = z
  .object({
    ...metricBudgetShape(AUDIT_METRICS),
    a11y: a11yBudgetSchema.optional(),
  })
  .strict() as unknown as z.ZodType<BudgetSet>;

const auditUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'URL must start with http:// or https://',
  });

const authSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bearer'),
      token: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('basic'),
      username: z.string().min(1),
      password: z.string().min(1),
    })
    .strict(),
]);

const apiBudgetsSchema = z
  .object(metricBudgetShape(API_METRICS))
  .strict() as unknown as z.ZodType<ApiBudgetSet>;

// API latency is environment-specific, so the defaults only gate regressions
// and stay warnings until a team opts into absolute maxima.
function defaultApiBudgets(): ApiBudgetSet {
  return {
    ttfb: { regression: 20, severity: 'warn' },
    duration: { regression: 20, severity: 'warn' },
  };
}

const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const satisfies readonly HttpMethod[];

const statusCodeSchema = z.number().int().min(100).max(599);

const apiTargetSchema = z
  .object({
    url: auditUrlSchema,
    method: z.enum(HTTP_METHODS).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    auth: authSchema.optional(),
    runs: z.number().int().min(1).max(10).optional(),
    timeoutMs: z.number().int().positive().optional(),
    expectStatus: z.union([statusCodeSchema, z.array(statusCodeSchema).min(1)]).optional(),
    budgets: apiBudgetsSchema.optional(),
  })
  .strict()
  .refine(
    (target) => {
      const method = target.method ?? 'GET';
      return target.body === undefined || (method !== 'GET' && method !== 'HEAD');
    },
    { message: 'GET and HEAD API targets cannot set a request body.', path: ['body'] },
  );

const pageTargetSchema = z
  .object({
    url: auditUrlSchema,
    preset: z.enum(['mobile', 'desktop']).optional(),
    runs: z.number().int().min(1).max(10).optional(),
    auth: authSchema.optional(),
    budgets: budgetsSchema.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    preset: z.enum(['mobile', 'desktop']).default('mobile'),
    runs: z.number().int().min(1).max(10).default(3),
    strict: z.boolean().default(false),
    retries: z.number().int().nonnegative().max(10).default(1),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    warmup: z.enum(['full', 'navigate', 'none']).default('navigate'),
    concurrency: z.number().int().min(1).max(8).default(DEFAULT_CONCURRENCY),
    urls: z.array(z.union([auditUrlSchema, pageTargetSchema])).default([]),
    budgets: budgetsSchema.default({}),
    api: z.array(apiTargetSchema).default([]),
    apiBudgets: apiBudgetsSchema.default(defaultApiBudgets),
    report: z
      .object({
        outDir: z.string().min(1).default('.pulse'),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .refine((config) => config.urls.length > 0 || config.api.length > 0, {
    message: 'Set at least one page URL or API endpoint.',
    path: ['urls'],
  });

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
    raw = await readJsonFile(path);
  } catch (error) {
    if (isEnoent(error)) {
      throw new PulseConfigError(`No config found at ${path}. Run "pulse init" first.`, path);
    }
    throw new PulseConfigError(`Could not read ${path}: ${errorMessage(error)}`, path);
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

function mergeApiBudgets(base?: ApiBudgetSet, override?: Partial<ApiBudgetSet>): ApiBudgetSet {
  const merged: ApiBudgetSet = { ...(base ?? {}) };
  if (!override) return merged;

  for (const key of API_METRICS.map((metric) => metric.key)) {
    const rule = mergeBudgetRule(base?.[key], override[key]);
    if (rule) merged[key] = rule;
  }

  return merged;
}

/** Apply one URL's page-level overrides on top of the global config. */
export function resolvePageConfig(config: PulseConfig, target: string | PageTarget): ResolvedPageConfig {
  const page: PageTarget = typeof target === 'string' ? { url: target } : target;

  return {
    ...config,
    preset: page.preset ?? config.preset,
    runs: page.runs ?? config.runs,
    auth: page.auth,
    urls: [page.url],
    budgets: page.budgets ? mergeBudgets(config.budgets, page.budgets) : { ...config.budgets },
  };
}

/** One fully resolved config per URL, in declaration order. */
export function resolveTargets(config: PulseConfig): ResolvedPageConfig[] {
  return config.urls.map((target) => resolvePageConfig(config, target));
}

/** One fully resolved target per API endpoint, in declaration order. */
export function resolveApiTargets(config: PulseConfig): ResolvedApiTarget[] {
  return (config.api ?? []).map((target: ApiTarget) => ({
    url: target.url,
    method: target.method ?? 'GET',
    headers: target.headers,
    body: target.body,
    auth: target.auth,
    runs: target.runs ?? config.runs,
    retries: config.retries ?? 1,
    timeoutMs: target.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    expectStatus: target.expectStatus,
    budgets: mergeApiBudgets(config.apiBudgets, target.budgets),
  }));
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
    // Failed subresources are a correctness gate: inherited failures become the
    // ceiling and any increase fails, even when `max` is inherited debt.
    failedRequests: { max: metrics.failedRequests, regression: 0 },
    thirdPartyBytes,
    thirdPartyRequests,
    longTasks: { max: Math.max(10, metrics.longTasks + 2), regression: 20, severity: 'warn' },
    thirdPartyMainThread: {
      max: Math.max(200, Math.ceil((metrics.thirdPartyMainThread * 1.2) / 50) * 50),
      regression: 20,
      severity: 'warn',
    },
    // Any new console error is debt; inherited errors become the ceiling.
    consoleErrors: { max: metrics.consoleErrors, regression: 0 },
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
    timeoutMs: DEFAULT_TIMEOUT_MS,
    warmup: 'navigate',
    concurrency: DEFAULT_CONCURRENCY,
    urls,
    api: [],
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
      failedRequests: { max: 0, regression: 0 },
      thirdPartyBytes: { max: 300 * 1024, regression: 15, severity: 'warn' },
      thirdPartyRequests: { max: 20, regression: 20, severity: 'warn' },
      longTasks: { max: 10, regression: 20, severity: 'warn' },
      thirdPartyMainThread: { max: 200, regression: 20, severity: 'warn' },
      consoleErrors: { max: 0, regression: 0 },
      a11y: {
        maxViolations: 0,
        maxNew: 0,
        maxNewByImpact: { critical: 0, serious: 0 },
      },
    },
    apiBudgets: defaultApiBudgets(),
    report: { outDir: '.pulse' },
  };
}

function serializeTarget(target: string | PageTarget): string | PageTarget {
  if (typeof target === 'string') return target;

  const page: PageTarget = { url: target.url };
  if (target.preset !== undefined) page.preset = target.preset;
  if (target.runs !== undefined) page.runs = target.runs;
  if (target.auth !== undefined) page.auth = target.auth;
  if (target.budgets !== undefined && Object.keys(target.budgets).length > 0) {
    page.budgets = target.budgets;
  }

  const hasOverrides =
    page.preset !== undefined ||
    page.runs !== undefined ||
    page.auth !== undefined ||
    (page.budgets !== undefined && Object.keys(page.budgets).length > 0);

  return hasOverrides ? page : page.url;
}

function serializeApiTarget(target: ApiTarget): ApiTarget {
  const api: ApiTarget = { url: target.url };
  if (target.method !== undefined) api.method = target.method;
  if (target.headers !== undefined && Object.keys(target.headers).length > 0) api.headers = target.headers;
  if (target.body !== undefined) api.body = target.body;
  if (target.auth !== undefined) api.auth = target.auth;
  if (target.runs !== undefined) api.runs = target.runs;
  if (target.timeoutMs !== undefined) api.timeoutMs = target.timeoutMs;
  if (target.expectStatus !== undefined) api.expectStatus = target.expectStatus;
  if (target.budgets !== undefined && Object.keys(target.budgets).length > 0) {
    api.budgets = target.budgets;
  }
  return api;
}

export async function writeConfig(path: string, config: PulseConfig): Promise<void> {
  // JSON round-trip strips undefined keys so a page target with no overrides can
  // be written back as a plain URL string.
  const clean = JSON.parse(JSON.stringify(config)) as PulseConfig;
  const serializable: PulseConfig = {
    ...clean,
    urls: clean.urls.map(serializeTarget),
  };

  const api = (clean.api ?? []).map(serializeApiTarget);
  if (api.length > 0) {
    serializable.api = api;
    if (clean.apiBudgets) serializable.apiBudgets = clean.apiBudgets;
  } else {
    // Do not make every UI-only config look like it contains API settings.
    delete serializable.api;
    delete serializable.apiBudgets;
  }

  await writeJsonFile(path, serializable);
}
