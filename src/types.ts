export type Preset = 'mobile' | 'desktop';
/**
 * How to warm the browser before the measured runs:
 * - `navigate` loads the page once in a plain Chrome tab (default, cheapest),
 * - `full` runs and discards a complete Lighthouse audit (legacy behaviour),
 * - `none` starts measuring on a cold browser.
 */
export type WarmupMode = 'full' | 'navigate' | 'none';
export type Severity = 'error' | 'warn';
export type Status = 'pass' | 'fail' | 'warn';
export type A11yImpact = 'critical' | 'serious' | 'moderate' | 'minor';
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type ApiMetricKey = 'ttfb' | 'duration' | 'bytes';

export interface BearerAuth {
  type: 'bearer';
  token: string;
}

export interface BasicAuth {
  type: 'basic';
  username: string;
  password: string;
}

/** Auth is resolved from the environment at run time; it is never written to a report. */
export type AuthConfig = BearerAuth | BasicAuth;

export interface BudgetRule {
  /** Absolute ceiling. Fails when exceeded (unless it is not also a regression). */
  max?: number;
  /** Percentage change versus baseline that is allowed before failing. */
  regression?: number;
  severity?: Severity;
}

export interface ApiBudgetSet {
  ttfb?: BudgetRule;
  duration?: BudgetRule;
  bytes?: BudgetRule;
}

export interface A11yBudget {
  severity?: Severity;
  /** Maximum total violation nodes. */
  maxViolations?: number;
  /** Maximum violation nodes that were not present in the baseline. */
  maxNew?: number;
  /** Maximum new violation nodes per axe impact level. */
  maxNewByImpact?: Partial<Record<A11yImpact, number>>;
  /** axe rule ids to remove before comparing. */
  ignoreRules?: string[];
}

export interface BudgetSet {
  lcp?: BudgetRule;
  cls?: BudgetRule;
  tbt?: BudgetRule;
  fcp?: BudgetRule;
  ttfb?: BudgetRule;
  js?: BudgetRule;
  css?: BudgetRule;
  fonts?: BudgetRule;
  images?: BudgetRule;
  total?: BudgetRule;
  requests?: BudgetRule;
  thirdPartyBytes?: BudgetRule;
  thirdPartyRequests?: BudgetRule;
  a11y?: A11yBudget;
}

export interface PageTarget {
  url: string;
  preset?: Preset;
  runs?: number;
  auth?: AuthConfig;
  budgets?: Partial<BudgetSet>;
}

export interface ApiTarget {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  auth?: AuthConfig;
  runs?: number;
  timeoutMs?: number;
  /** Exact status code, or list of exact codes, that count as success. Defaults to 2xx–3xx. */
  expectStatus?: number | number[];
  budgets?: Partial<ApiBudgetSet>;
}

export interface PulseConfig {
  preset: Preset;
  runs: number;
  /** When true an absolute max breach fails even if the metric improved. */
  strict?: boolean;
  /** Extra attempts after a failed Lighthouse run. */
  retries?: number;
  /** Lighthouse maxWaitForLoad, in milliseconds. */
  timeoutMs?: number;
  /** Browser warm-up before the measured runs. Defaults to `navigate`. */
  warmup?: WarmupMode;
  urls: Array<string | PageTarget>;
  budgets: BudgetSet;
  /** Authenticated API endpoints measured with fetch instead of Lighthouse. */
  api?: ApiTarget[];
  /** Defaults for every API endpoint; per-target budgets deep-merge over this block. */
  apiBudgets?: ApiBudgetSet;
  report: {
    outDir: string;
  };
}

/** A page target after global preset/runs/budgets and its auth block are applied. */
export interface ResolvedPageConfig extends PulseConfig {
  auth?: AuthConfig;
}

/** An API target after global runs/timeout/auth and budget defaults are applied. */
export interface ResolvedApiTarget {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  auth?: AuthConfig;
  runs: number;
  retries: number;
  timeoutMs: number;
  expectStatus?: number | number[];
  budgets: ApiBudgetSet;
}

export interface A11yNode {
  selector: string;
  snippet?: string;
  impact?: A11yImpact;
  failureSummary?: string;
}

export interface A11yViolation {
  id: string;
  title: string;
  impact: A11yImpact;
  nodes: A11yNode[];
}

export interface RequestSummary {
  url: string;
  resourceType: string;
  bytes: number;
  thirdParty: boolean;
}

export interface LcpElement {
  selector: string;
  url?: string;
  snippet?: string;
}

export interface AuditMetrics {
  lcp: number;
  cls: number;
  tbt: number;
  fcp: number;
  ttfb: number;
  js: number;
  css: number;
  fonts: number;
  images: number;
  total: number;
  requests: number;
  thirdPartyBytes: number;
  thirdPartyRequests: number;
  violations: number;
}

export interface AuditResult {
  url: string;
  preset: Preset;
  runs: number;
  capturedAt: string;
  lighthouseVersion?: string;
  chromeVersion?: string;
  metrics: AuditMetrics;
  lcpElement?: LcpElement;
  heaviest: RequestSummary[];
  violations: A11yViolation[];
  /** One entry per measured run, warm-up excluded. */
  samples?: AuditMetrics[];
  /** Top 10 third-party requests by bytes. */
  thirdPartyHeaviest?: RequestSummary[];
}

export interface ApiMetrics {
  /** Time until response headers arrived, in milliseconds. */
  ttfb: number;
  /** Time until the complete response body was read, in milliseconds. */
  duration: number;
  /** Response body size in bytes. */
  bytes: number;
  status: number;
}

export interface ApiResult {
  url: string;
  method: HttpMethod;
  runs: number;
  capturedAt: string;
  metrics: ApiMetrics;
  /** One entry per measured run. API runs are not warmed up. */
  samples?: ApiMetrics[];
}

export interface BaselineFile {
  version: 3;
  results: Record<string, AuditResult>;
  apiResults?: Record<string, ApiResult>;
}

export interface Check {
  metric: string;
  label: string;
  value: number;
  formatted: string;
  format: 'ms' | 'score' | 'bytes' | 'count';
  baseline?: number;
  baselineFormatted?: string;
  max?: number;
  delta?: number;
  deltaPct?: number;
  status: Status;
  severity: Severity;
  reason: string;
}

export interface ReportEntry {
  url: string;
  audit: AuditResult;
  baseline: AuditResult | null;
  checks: Check[];
  /** Axe rules removed before comparison, shown so suppression stays visible. */
  ignoredRules?: string[];
  /** Violation nodes removed by `ignoreRules`. */
  ignoredViolations?: number;
}

export interface ApiReportEntry {
  url: string;
  method: HttpMethod;
  result: ApiResult;
  baseline: ApiResult | null;
  checks: Check[];
}

export interface PulseReport {
  version: string;
  generatedAt: string;
  preset: Preset;
  presets: Preset[];
  runs: number;
  results: ReportEntry[];
  /** Authenticated API timings, kept separate from UI page checks. */
  apiResults?: ApiReportEntry[];
  failed: number;
  warned: number;
  passed: number;
}
