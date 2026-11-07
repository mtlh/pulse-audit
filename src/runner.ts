import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { resolveAuthHeaders } from './auth.js';
import { findChromeBinary } from './chrome.js';
import { countViolationNodes, violationKey } from './compare.js';
import { extractResult, worstImpact } from './extract.js';
import type {
  A11yImpact,
  A11yNode,
  A11yViolation,
  AuditMetrics,
  AuditResult,
  AuthConfig,
  Preset,
} from './types.js';
import { median } from './util/median.js';
import { AUDIT_METRIC_KEYS } from './util/variance.js';

const MOBILE_SCREEN = { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true };
const DESKTOP_SCREEN = { width: 1350, height: 940, deviceScaleFactor: 1, mobile: false };

// Matches Lighthouse's mobile default. Kept explicit so a baseline is always
// captured under the same conditions.
const MOBILE_THROTTLING = {
  rttMs: 150,
  throughputKbps: 1638.4,
  requestLatencyMs: 562.5,
  downloadThroughputKbps: 1474.56,
  uploadThroughputKbps: 675,
  cpuSlowdownMultiplier: 4,
};

const DESKTOP_THROTTLING = {
  rttMs: 40,
  throughputKbps: 10_240,
  cpuSlowdownMultiplier: 1,
};

// The first run pays for Chrome startup, font loading and DNS. It is measured
// but never reported or compared, so a baseline is always N steady-state runs.
const WARMUP_RUNS = 1;

export interface AuditOptions {
  preset: Preset;
  runs: number;
  retries?: number;
  timeoutMs?: number;
  /** Bearer or Basic auth, applied as an extra request header to every page request. */
  auth?: AuthConfig;
}

function richerText(current: string | undefined, next: string | undefined): string | undefined {
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
}

function mergeImpact(current?: A11yImpact, next?: A11yImpact): A11yImpact | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  if (current === next) return current;
  return worstImpact([current, next]);
}

function mergeNode(current: A11yNode, next: A11yNode): A11yNode {
  return {
    selector: current.selector || next.selector,
    snippet: richerText(current.snippet, next.snippet),
    impact: mergeImpact(current.impact, next.impact),
    failureSummary: current.failureSummary || next.failureSummary,
  };
}

/**
 * Unions violations across measured runs. Nodes are identified by rule id +
 * selector + failure summary; when the same node appears in several runs the
 * richest detail wins (snippet, failure summary and the worst impact).
 */
function unionViolations(results: AuditResult[]): A11yViolation[] {
  const byId = new Map<string, A11yViolation>();
  const nodeIndex = new Map<string, A11yNode>();
  const impactsById = new Map<string, Array<A11yImpact | undefined>>();

  for (const result of results) {
    for (const violation of result.violations) {
      let merged = byId.get(violation.id);
      if (!merged) {
        merged = {
          id: violation.id,
          title: violation.title,
          impact: violation.impact,
          nodes: [],
        };
        byId.set(violation.id, merged);
        impactsById.set(violation.id, []);
      } else {
        merged.title = richerText(merged.title, violation.title) ?? merged.title;
      }
      impactsById.get(violation.id)!.push(violation.impact);

      for (const node of violation.nodes) {
        impactsById.get(violation.id)!.push(node.impact);
        const key = violationKey(violation.id, node.selector, node.failureSummary);
        const existing = nodeIndex.get(key);
        if (!existing) {
          const copy = { ...node };
          nodeIndex.set(key, copy);
          merged.nodes.push(copy);
        } else {
          Object.assign(existing, mergeNode(existing, node));
        }
      }
    }
  }

  const union = [...byId.values()];
  for (const violation of union) {
    violation.impact = worstImpact(impactsById.get(violation.id) ?? []);
  }
  return union;
}

/**
 * Picks the run with the median LCP and uses its detail data (LCP element,
 * request lists). Numeric metrics are medianed across all runs and a11y
 * violations are unioned so a flaky single run cannot hide new debt.
 */
export function pickMedianRun(results: AuditResult[]): AuditResult {
  if (results.length === 0) throw new Error('No audit runs to pick from');

  if (results.length === 1) {
    const only = results[0];
    return { ...only, samples: [{ ...only.metrics }] };
  }

  const byLcp = [...results].sort((a, b) => a.metrics.lcp - b.metrics.lcp);
  const chosen = byLcp[Math.floor(byLcp.length / 2)];
  const violations = unionViolations(results);

  const metrics = {} as AuditMetrics;
  for (const key of AUDIT_METRIC_KEYS) {
    metrics[key] = median(results.map((result) => result.metrics[key]));
  }
  // Keep the count tied to the violation array that ships with the report.
  metrics.violations = countViolationNodes({ violations });

  return {
    ...chosen,
    metrics,
    violations,
    samples: results.map((result) => ({ ...result.metrics })),
  };
}

async function measureOnce(
  url: string,
  chromePort: number,
  options: AuditOptions,
  runNumber: number,
  extraHeaders: Record<string, string> | undefined,
): Promise<AuditResult> {
  const retries = Math.max(0, options.retries ?? 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const runner = await lighthouse(url, {
        port: chromePort,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility'],
        formFactor: options.preset,
        screenEmulation: options.preset === 'mobile' ? MOBILE_SCREEN : DESKTOP_SCREEN,
        throttling: options.preset === 'mobile' ? MOBILE_THROTTLING : DESKTOP_THROTTLING,
        throttlingMethod: 'simulate',
        maxWaitForLoad: options.timeoutMs ?? 120_000,
        // Lighthouse applies these to every request in the audit, so the token
        // must be scoped to the staging environment rather than production.
        ...(extraHeaders ? { extraHeaders } : {}),
        // Screenshots are expensive to capture and encode, and Pulse never
        // reads them. Dropping them shortens every run without changing the
        // metrics or axe results that are reported.
        disableFullPageScreenshot: true,
      } as any);

      if (!runner) throw new Error('Lighthouse returned no result');
      return extractResult(runner.lhr as any, url, options.preset, options.runs);
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Audit failed for ${url} on run ${runNumber} after ${retries + 1} attempt(s): ${message}`);
}

export async function runAudit(url: string, options: AuditOptions): Promise<AuditResult> {
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`runs must be a positive integer, received ${options.runs}`);
  }

  const binary = findChromeBinary();
  if (!binary.path) throw new Error(binary.detail);

  // Resolve once so a missing secret fails before Chrome is launched.
  const extraHeaders = options.auth ? resolveAuthHeaders(options.auth) : undefined;

  const chrome = await chromeLauncher
    .launch({
      chromePath: binary.path,
      // --no-sandbox and --disable-dev-shm-usage are required in containers and
      // common on WSL, where the default Chrome sandbox cannot start.
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const context = binary.wsl ? ' WSL tip: install Chrome for Linux inside the distro.' : '';
      throw new Error(`Could not launch Chrome at ${binary.path}.${context} ${message}`);
    });

  try {
    const results: AuditResult[] = [];

    for (let run = 0; run < options.runs + WARMUP_RUNS; run += 1) {
      const result = await measureOnce(url, chrome.port, options, run + 1, extraHeaders);
      if (run < WARMUP_RUNS) continue;
      results.push(result);
    }

    return pickMedianRun(results);
  } finally {
    await chrome.kill();
  }
}
