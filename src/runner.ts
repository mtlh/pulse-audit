import * as chromeLauncher from 'chrome-launcher';
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
  WarmupMode,
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

// Lighthouse is a heavy module tree (~1.6 s to import). Loading it lazily
// keeps `pulse doctor`, `baseline`, `--version` and library imports fast, and
// lets the audit start the import alongside the Chrome launch.
type LighthouseModule = typeof import('lighthouse');
type LighthouseRunner = LighthouseModule['default'];
interface PuppeteerPage {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  close(): Promise<void>;
}
interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>;
  disconnect(): void;
}
interface PuppeteerModule {
  connect(options: { browserURL: string }): Promise<PuppeteerBrowser>;
}
let lighthouseModule: Promise<LighthouseModule> | undefined;
let puppeteerModule: Promise<PuppeteerModule> | undefined;

function loadLighthouse(): Promise<LighthouseModule> {
  // Return the whole namespace so both the runner and `defaultConfig` (used to
  // derive the audit skip list) come from the same cached import.
  lighthouseModule ??= import('lighthouse');
  return lighthouseModule;
}

// The only performance audits Pulse reads. Everything else in the performance
// category runs a gatherer and/or audit whose result is discarded, so it is
// skipped to shorten each Lighthouse run.
export const REQUIRED_PERFORMANCE_AUDITS: ReadonlySet<string> = new Set([
  'first-contentful-paint',
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'server-response-time',
  'network-requests',
  'lcp-breakdown-insight',
]);

interface LighthouseConfigLike {
  categories?: Record<string, { auditRefs?: ReadonlyArray<{ id?: string }> }> | null;
}

/**
 * Derives the performance audits Pulse does not read from the installed
 * Lighthouse config. New audits are skipped automatically, and a renamed or
 * missing config property yields an empty list so the run stays safe.
 */
export function computePerformanceSkipAudits(config: LighthouseConfigLike | undefined): string[] {
  const refs = config?.categories?.performance?.auditRefs;
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => (typeof ref?.id === 'string' ? ref.id : undefined))
    .filter((id): id is string => id !== undefined && !REQUIRED_PERFORMANCE_AUDITS.has(id));
}

function loadPuppeteer(): Promise<PuppeteerModule> {
  // Importing Lighthouse already pulls puppeteer-core into the module graph, so
  // this resolves from cache by the time the warm-up runs. The explicit
  // dependency keeps strict package managers happy.
  puppeteerModule ??= import('puppeteer-core').then((module) => module.default as unknown as PuppeteerModule);
  return puppeteerModule;
}

export interface AuditOptions {
  preset: Preset;
  runs: number;
  retries?: number;
  timeoutMs?: number;
  /** Bearer or Basic auth, applied as an extra request header to every page request. */
  auth?: AuthConfig;
  warmup?: WarmupMode;
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

/**
 * Warms DNS, TLS, the server cache and the JS compiler without paying for a
 * full Lighthouse trace and axe pass. Best effort: if the preload fails, the
 * measured runs still decide the result.
 */
async function warmUpNavigation(url: string, chromePort: number, timeoutMs: number): Promise<void> {
  try {
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chromePort}` });
    try {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      } finally {
        await page.close();
      }
    } finally {
      browser.disconnect();
    }
  } catch {
    // A failed preload is not an audit failure; the measured runs follow.
  }
}

async function measureOnce(
  url: string,
  chromePort: number,
  options: AuditOptions,
  runLabel: number | string,
  lighthouse: LighthouseRunner,
  skipAudits: string[],
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
        // Skipping audits Pulse never reads cuts ~15-25% off each run. The
        // list is derived from the installed config, so it stays in sync with
        // new Lighthouse audits.
        ...(skipAudits.length > 0 ? { skipAudits } : {}),
      } as any);

      if (!runner) throw new Error('Lighthouse returned no result');
      return extractResult(runner.lhr as any, url, options.preset, options.runs);
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Audit failed for ${url} on run ${runLabel} after ${retries + 1} attempt(s): ${message}`);
}

export async function runAudit(url: string, options: AuditOptions): Promise<AuditResult> {
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`runs must be a positive integer, received ${options.runs}`);
  }

  const binary = findChromeBinary();
  if (!binary.path) throw new Error(binary.detail);

  // Resolve once so a missing secret fails before Chrome is launched.
  const extraHeaders = options.auth ? resolveAuthHeaders(options.auth) : undefined;
  const warmup = options.warmup ?? 'navigate';
  const timeoutMs = options.timeoutMs ?? 120_000;

  // Start the Lighthouse import and the browser together: the import is the
  // larger of the two, so the Chrome launch is effectively free.
  const [chromeResult, lighthouseResult] = await Promise.allSettled([
    chromeLauncher
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
      }),
    loadLighthouse(),
  ]);

  if (chromeResult.status === 'rejected') throw chromeResult.reason;
  if (lighthouseResult.status === 'rejected') {
    // Do not leak a browser when the module fails to load after it started.
    await chromeResult.value.kill();
    throw lighthouseResult.reason;
  }

  const chrome = chromeResult.value;
  const lighthouse = lighthouseResult.value.default;
  const skipAudits = computePerformanceSkipAudits(lighthouseResult.value.defaultConfig);

  try {
    if (warmup === 'navigate') {
      await warmUpNavigation(url, chrome.port, timeoutMs);
    } else if (warmup === 'full') {
      // Legacy behaviour: pay for one discarded Lighthouse run.
      await measureOnce(url, chrome.port, options, 'warm-up', lighthouse, skipAudits, extraHeaders);
    }

    const results: AuditResult[] = [];
    for (let run = 0; run < options.runs; run += 1) {
      results.push(
        await measureOnce(url, chrome.port, options, run + 1, lighthouse, skipAudits, extraHeaders),
      );
    }

    return pickMedianRun(results);
  } finally {
    await chrome.kill();
  }
}
