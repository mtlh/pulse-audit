export type Preset = 'mobile' | 'desktop';
export type Severity = 'error' | 'warn';
export type Status = 'pass' | 'fail' | 'warn';

export interface BudgetRule {
  /** Absolute ceiling. Fails when exceeded (unless it is not also a regression). */
  max?: number;
  /** Percentage change versus baseline that is allowed before failing. */
  regression?: number;
  severity?: Severity;
}

export interface A11yBudget extends BudgetRule {
  /** Maximum total violation nodes. */
  maxViolations?: number;
  /** Maximum violation nodes that were not present in the baseline. */
  maxNew?: number;
}

export interface PulseConfig {
  preset: Preset;
  runs: number;
  urls: string[];
  budgets: {
    lcp?: BudgetRule;
    cls?: BudgetRule;
    tbt?: BudgetRule;
    js?: BudgetRule;
    images?: BudgetRule;
    requests?: BudgetRule;
    a11y?: A11yBudget;
  };
  report: {
    outDir: string;
  };
}

export interface A11yNode {
  selector: string;
  snippet?: string;
}

export interface A11yViolation {
  id: string;
  title: string;
  impact: string;
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
  js: number;
  images: number;
  requests: number;
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
}

export interface BaselineFile {
  version: 1;
  results: Record<string, AuditResult>;
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
}

export interface PulseReport {
  version: string;
  generatedAt: string;
  preset: Preset;
  runs: number;
  results: ReportEntry[];
  failed: number;
  warned: number;
  passed: number;
}
