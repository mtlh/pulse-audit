import * as chromeLauncher from 'chrome-launcher';
import type * as LighthouseNamespace from './lighthouse.js';
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
import { mapWithConcurrency } from './scheduler.js';
import { DEFAULT_TIMEOUT_MS, WARMUP_TIMEOUT_MS } from './util/defaults.js';
import { errorMessage } from './util/errors.js';
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
type LighthouseModule = typeof LighthouseNamespace;
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
  lighthouseModule ??= import('./lighthouse.js');
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
  'long-tasks',
  'third-parties-insight',
]);

/**
 * Categories Lighthouse must run. `best-practices` is here only for
 * `errors-in-console`; Pulse reports no best-practices score and does not skip
 * that category's other audits, because they are not what makes the run long.
 */
export const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'best-practices'] as const;

interface LighthouseConfigLike {
  categories?: Record<string, { auditRefs?: readonly { id?: string }[] } | undefined> | null;
}

/**
 * Derives the performance audits Pulse does not read from the installed
 * Lighthouse config. New audits are skipped automatically, and a renamed or
 * missing config property yields an empty list so the run stays safe.
 */
export function computePerformanceSkipAudits(config: LighthouseConfigLike | undefined): string[] {
  const refs = config?.categories?.performance?.auditRefs;
  if (!Array.isArray(refs)) return [];
  // `Array.isArray` narrows a readonly array to `any[]`; restore the element
  // type before reading `id`.
  const auditRefs: readonly { id?: string }[] = refs;
  return auditRefs
    .map((ref) => (typeof ref.id === 'string' ? ref.id : undefined))
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
  /**
   * Called as the warm-up and each measured run start and finish. Long CI
   * audits otherwise look hung between the first log line and the report.
   */
  onProgress?: (event: AuditProgressEvent) => void;
}

/**
 * One step of an audit. `durationMs` is set on a finish event, including a
 * failed run, so callers can show where the time went before the error lands.
 */
export interface AuditProgressEvent {
  phase: 'warmup' | 'run';
  /** The URL this event belongs to, so concurrent audits stay attributable. */
  url?: string;
  /** 1-based measured-run number. Absent for the warm-up. */
  run?: number;
  runs?: number;
  status: 'start' | 'done' | 'failed';
  durationMs?: number;
}

/** The subset of a chrome-launcher instance the session needs. */
export interface ChromeInstance {
  port: number;
  kill(): void | Promise<void>;
}

/**
 * Injection points used by tests. Production callers should leave these
 * undefined so the real chrome-launcher and Lighthouse are used.
 */
export interface AuditSessionDeps {
  launchChrome?: (chromePath: string) => Promise<ChromeInstance>;
  loadLighthouse?: () => Promise<LighthouseModule>;
}

export interface AuditSession {
  readonly port: number;
  /** Warm-up plus every measured run for one URL, using the shared browser. */
  auditTarget(url: string, options: AuditOptions): Promise<AuditResult>;
  /** Kills the browser once. Safe to call more than once. */
  close(): Promise<void>;
}

export interface AuditTargetResult {
  result: AuditResult;
  method?: 'lighthouse' | 'fast';
  enforcedBudgets?: string[];
}

export interface AuditTargetSpec {
  url: string;
  /** Serialisable options for the concurrent worker path. */
  options?: AuditOptions;
  /** Main-thread override used by `--fast`; only valid with concurrency 1. */
  audit?: (session: AuditSession) => Promise<AuditTargetResult>;
}

export type AuditTargetOutcome =
  | {
      url: string;
      status: 'ok';
      result: AuditResult;
      method?: 'lighthouse' | 'fast';
      enforcedBudgets?: string[];
    }
  | { url: string; status: 'error'; error: string };

export interface AuditTargetsOptions {
  /** Maximum number of URLs in flight. Runs for one URL stay sequential. */
  concurrency?: number;
  /** Called once per target before its warm-up starts. */
  onTargetStart?: (target: AuditTargetSpec) => void;
  /** Progress forwarded from a concurrent worker. */
  onProgress?: (event: AuditProgressEvent) => void;
  /** Aborting asks worker lanes to close their browsers and stop. */
  signal?: AbortSignal;
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
    failureSummary: current.failureSummary ?? next.failureSummary,
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
  const impactsById = new Map<string, (A11yImpact | undefined)[]>();

  for (const result of results) {
    for (const violation of result.violations) {
      let merged = byId.get(violation.id);
      let impacts = impactsById.get(violation.id);
      if (!merged || !impacts) {
        merged = {
          id: violation.id,
          title: violation.title,
          impact: violation.impact,
          nodes: [],
        };
        impacts = [];
        byId.set(violation.id, merged);
        impactsById.set(violation.id, impacts);
      } else {
        merged.title = richerText(merged.title, violation.title) ?? merged.title;
      }
      impacts.push(violation.impact);

      for (const node of violation.nodes) {
        impacts.push(node.impact);
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
 *
 * The timeout is capped at `WARMUP_TIMEOUT_MS`. A page with a stalled
 * third-party request can otherwise hold the warm-up for the full measured-run
 * timeout before the real audit even starts.
 */
async function warmUpNavigation(url: string, chromePort: number): Promise<void> {
  try {
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chromePort}` });
    try {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: WARMUP_TIMEOUT_MS });
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
        onlyCategories: [...LIGHTHOUSE_CATEGORIES],
        formFactor: options.preset,
        screenEmulation: options.preset === 'mobile' ? MOBILE_SCREEN : DESKTOP_SCREEN,
        throttling: options.preset === 'mobile' ? MOBILE_THROTTLING : DESKTOP_THROTTLING,
        throttlingMethod: 'simulate',
        maxWaitForLoad: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
      } as unknown as Parameters<LighthouseRunner>[1]);

      if (!runner) throw new Error('Lighthouse returned no result');
      // Lighthouse's Result type does not expose the index signature its
      // versioned LHR shape needs; the extractor validates every field anyway.
      return extractResult(
        runner.lhr as unknown as Parameters<typeof extractResult>[0],
        url,
        options.preset,
        options.runs,
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Audit failed for ${url} on run ${runLabel} after ${retries + 1} attempt(s): ${errorMessage(lastError)}`,
  );
}

async function measureTarget(
  url: string,
  options: AuditOptions,
  chromePort: number,
  lighthouse: LighthouseRunner,
  skipAudits: string[],
): Promise<AuditResult> {
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`runs must be a positive integer, received ${options.runs}`);
  }

  // Resolve per target so a missing secret fails this URL, not the whole session.
  const extraHeaders = options.auth ? resolveAuthHeaders(options.auth) : undefined;
  const warmup = options.warmup ?? 'navigate';
  const onProgress = options.onProgress ?? (() => undefined);

  if (warmup !== 'none') {
    const startedAt = Date.now();
    onProgress({ phase: 'warmup', url, status: 'start' });
    if (warmup === 'navigate') {
      await warmUpNavigation(url, chromePort);
    } else {
      // Legacy behaviour: pay for one discarded Lighthouse run.
      await measureOnce(url, chromePort, options, 'warm-up', lighthouse, skipAudits, extraHeaders);
    }
    onProgress({ phase: 'warmup', url, status: 'done', durationMs: Date.now() - startedAt });
  }

  const results: AuditResult[] = [];
  for (let run = 0; run < options.runs; run += 1) {
    const startedAt = Date.now();
    const runLabel = run + 1;
    onProgress({ phase: 'run', url, run: runLabel, runs: options.runs, status: 'start' });
    try {
      results.push(
        await measureOnce(url, chromePort, options, runLabel, lighthouse, skipAudits, extraHeaders),
      );
    } catch (error) {
      onProgress({
        phase: 'run',
        url,
        run: runLabel,
        runs: options.runs,
        status: 'failed',
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
    onProgress({
      phase: 'run',
      url,
      run: runLabel,
      runs: options.runs,
      status: 'done',
      durationMs: Date.now() - startedAt,
    });
  }

  return pickMedianRun(results);
}

async function defaultLaunchChrome(chromePath: string): Promise<ChromeInstance> {
  return chromeLauncher.launch({
    chromePath,
    // --no-sandbox and --disable-dev-shm-usage are required in containers and
    // common on WSL, where the default Chrome sandbox cannot start.
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
}

/**
 * Launches Chrome once and loads Lighthouse once. `auditTarget` then runs the
 * warm-up and every measured run for a URL in that browser, so a multi-URL
 * command pays the launch cost once.
 *
 * The browser is killed by `close()`; callers must call it in a `finally`.
 */
export async function createAuditSession(deps: AuditSessionDeps = {}): Promise<AuditSession> {
  const binary = findChromeBinary();
  if (!binary.path) throw new Error(binary.detail);

  const launch = deps.launchChrome ?? defaultLaunchChrome;
  const importLighthouse = deps.loadLighthouse ?? loadLighthouse;

  // Start the Lighthouse import and the browser together: the import is the
  // larger of the two, so the Chrome launch is effectively free.
  const [chromeResult, lighthouseResult] = await Promise.allSettled([
    launch(binary.path).catch((error: unknown) => {
      const context = binary.wsl ? ' WSL tip: install Chrome for Linux inside the distro.' : '';
      throw new Error(`Could not launch Chrome at ${binary.path}.${context} ${errorMessage(error)}`);
    }),
    importLighthouse(),
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
  let closed = false;

  return {
    port: chrome.port,
    auditTarget: (url, options) => measureTarget(url, options, chrome.port, lighthouse, skipAudits),
    close: async () => {
      if (closed) return;
      closed = true;
      await chrome.kill();
    },
  };
}

interface WorkerItem {
  index: number;
  url: string;
  options: AuditOptions;
}

interface WorkerProgressMessage {
  type: 'progress';
  index: number;
  event: AuditProgressEvent;
}

type WorkerMessage =
  | { type: 'start'; index: number }
  | WorkerProgressMessage
  | { type: 'result'; index: number; result: AuditResult }
  | { type: 'error'; index: number; message: string }
  | { type: 'done' };

/** Worker entry file next to this module (`.ts` under tsx/vitest, `.js` in dist). */
function workerEntry(): URL {
  const here = new URL(import.meta.url);
  return new URL(here.pathname.endsWith('.ts') ? './audit-worker.ts' : './audit-worker.js', here);
}

/**
 * Lighthouse keeps a browser-wide tracing session and module-level trace-engine
 * singletons, so two audits cannot run concurrently in one process or one
 * Chrome. Each lane therefore gets its own worker thread and Chrome, which is
 * what `--concurrency` means. The default (1) stays on the main thread and uses
 * a single shared Chrome.
 */
async function auditTargetsInWorkers(
  targets: readonly AuditTargetSpec[],
  options: AuditTargetsOptions,
  concurrency: number,
): Promise<AuditTargetOutcome[]> {
  const { Worker } = await import('node:worker_threads');
  const outcomes = new Array<AuditTargetOutcome | undefined>(targets.length);
  const lanes = Math.min(concurrency, targets.length);
  const batches: WorkerItem[][] = Array.from({ length: lanes }, () => []);
  const workers = new Set<InstanceType<typeof Worker>>();

  targets.forEach((target, index) => {
    if (!target.options) {
      throw new Error(`Concurrent audits need serialisable options for ${target.url}`);
    }
    batches[index % lanes].push({ index, url: target.url, options: target.options });
  });

  const shutdown = (): void => {
    for (const worker of workers) {
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {
        // The lane already exited.
      }
    }
    // A stuck worker must not keep the process alive forever.
    const timer = setTimeout(() => {
      for (const worker of workers) {
        void worker.terminate().catch(() => {
          // The lane may already be gone.
        });
      }
    }, 2_000);
    timer.unref();
  };

  if (options.signal) {
    if (options.signal.aborted) shutdown();
    else options.signal.addEventListener('abort', shutdown, { once: true });
  }

  await Promise.all(
    batches.map(
      (batch) =>
        new Promise<void>((resolve) => {
          const worker = new Worker(workerEntry(), {
            workerData: { items: batch },
            execArgv: process.execArgv,
          });
          workers.add(worker);
          let finished = false;

          const finish = (): void => {
            if (finished) return;
            finished = true;
            workers.delete(worker);
            for (const item of batch) {
              outcomes[item.index] ??= {
                url: item.url,
                status: 'error',
                error: options.signal?.aborted ? 'Audit aborted' : 'Worker exited before returning a result',
              };
            }
            resolve();
          };

          if (options.signal?.aborted) {
            try {
              worker.postMessage({ type: 'shutdown' });
            } catch {
              // Already gone.
            }
          }

          worker.on('message', (message: WorkerMessage) => {
            if (message.type === 'start') {
              options.onTargetStart?.(targets[message.index]);
            } else if (message.type === 'progress') {
              options.onProgress?.(message.event);
            } else if (message.type === 'result') {
              outcomes[message.index] = {
                url: targets[message.index].url,
                status: 'ok',
                result: message.result,
                method: 'lighthouse',
              };
            } else if (message.type === 'error') {
              outcomes[message.index] = {
                url: targets[message.index].url,
                status: 'error',
                error: message.message,
              };
            } else {
              void worker.terminate();
              finish();
            }
          });

          worker.on('error', (error) => {
            for (const item of batch) {
              outcomes[item.index] ??= { url: item.url, status: 'error', error: errorMessage(error) };
            }
            finish();
          });
          worker.on('exit', (code) => {
            if (code !== 0) {
              for (const item of batch) {
                outcomes[item.index] ??= {
                  url: item.url,
                  status: 'error',
                  error: `Audit worker exited with code ${code}`,
                };
              }
            }
            finish();
          });
        }),
    ),
  );

  options.signal?.removeEventListener('abort', shutdown);
  return outcomes as AuditTargetOutcome[];
}

/**
 * Audits several URLs with bounded overlap. Runs for a single URL stay
 * sequential. At concurrency 1 the supplied session reuses one Chrome for the
 * whole run; higher values use one worker thread and Chrome per lane.
 * Outcomes are returned in target order, and one failed URL never stops the
 * others.
 */
export async function auditTargets(
  session: AuditSession | undefined,
  targets: readonly AuditTargetSpec[],
  options: AuditTargetsOptions = {},
): Promise<AuditTargetOutcome[]> {
  const concurrency = options.concurrency ?? 1;
  if (concurrency > 1) return auditTargetsInWorkers(targets, options, concurrency);
  if (!session) throw new Error('A session is required for a sequential audit');

  const outcomes = await mapWithConcurrency(targets, 1, async (target) => {
    options.onTargetStart?.(target);
    try {
      let audited: AuditTargetResult;
      if (target.audit) {
        audited = await target.audit(session);
      } else {
        if (!target.options) {
          throw new Error(`Audit target ${target.url} needs serialisable options`);
        }
        audited = {
          result: await session.auditTarget(target.url, {
            ...target.options,
            onProgress: options.onProgress,
          }),
        };
      }
      return {
        url: target.url,
        status: 'ok' as const,
        result: audited.result,
        method: audited.method,
        enforcedBudgets: audited.enforcedBudgets,
      };
    } catch (error) {
      return {
        url: target.url,
        status: 'error' as const,
        error: errorMessage(error),
      };
    }
  });
  return outcomes;
}

export async function runAudit(url: string, options: AuditOptions): Promise<AuditResult> {
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`runs must be a positive integer, received ${options.runs}`);
  }

  // Resolve once so a missing secret fails before Chrome is launched.
  if (options.auth) resolveAuthHeaders(options.auth);

  const session = await createAuditSession();
  try {
    return await session.auditTarget(url, options);
  } finally {
    await session.close();
  }
}
