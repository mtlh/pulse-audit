import { countViolationNodes } from './compare.js';
import type {
  A11yNode,
  A11yViolation,
  AuditMetrics,
  AuditResult,
  AuthConfig,
  A11yImpact,
  BudgetSet,
  Preset,
  RequestSummary,
} from './types.js';
import { resolveAuthHeaders } from './auth.js';
import { lighthouseMajor } from './baseline.js';
import { LIGHTHOUSE_VERSION } from './lighthouse-version.js';

/**
 * Metrics only a full Lighthouse run can measure comparably to a stored
 * baseline. The cheap path measures network sizes and axe only, so a configured
 * budget on any of these escalates instead of guessing.
 */
const TIMING_METRICS = [
  'lcp',
  'cls',
  'tbt',
  'fcp',
  'ttfb',
  'failedRequests',
  'longTasks',
  'thirdPartyMainThread',
  'consoleErrors',
] as const;

/** Metrics the cheap pre-check can measure from network events. */
const SIZE_METRICS = [
  'js',
  'css',
  'fonts',
  'images',
  'total',
  'requests',
  'thirdPartyBytes',
  'thirdPartyRequests',
] as const;

type TimingMetric = (typeof TIMING_METRICS)[number];

export interface FastMeasurement {
  url: string;
  /** Main-document HTTP status; 0 when the navigation produced no response. */
  status: number;
  metrics: AuditMetrics;
  requests: RequestSummary[];
  violations: A11yViolation[];
}

export interface FastDecisionInput {
  measurement: FastMeasurement;
  baseline: AuditResult | null;
  config: { budgets: BudgetSet; preset: Preset; runs: number };
  /** Version of the installed Lighthouse, used for baseline comparability. */
  lighthouseVersion?: string;
}

export interface FastDecision {
  /** True when the cheap result is trustworthy for every configured budget. */
  useFast: boolean;
  /** Why the pre-check escalated. Empty when `useFast` is true. */
  reasons: string[];
  /** Budget metrics a fast result actually enforced. */
  enforcedBudgets: string[];
}

function emptyMetrics(): AuditMetrics {
  return {
    lcp: 0,
    cls: 0,
    tbt: 0,
    fcp: 0,
    ttfb: 0,
    js: 0,
    css: 0,
    fonts: 0,
    images: 0,
    total: 0,
    requests: 0,
    failedRequests: 0,
    thirdPartyBytes: 0,
    thirdPartyRequests: 0,
    longTasks: 0,
    thirdPartyMainThread: 0,
    consoleErrors: 0,
    violations: 0,
  };
}

export function timingBudgetsConfigured(budgets: BudgetSet): TimingMetric[] {
  return TIMING_METRICS.filter((key) => {
    const rule = budgets[key];
    return rule !== undefined && (rule.max !== undefined || rule.regression !== undefined);
  });
}

/**
 * A cheap-path fingerprint keyed by axe rule id and node count.
 *
 * Lighthouse and axe generate selectors with different algorithms (and
 * Lighthouse 13 drops node failure summaries from its category details), so a
 * selector- or summary-based comparison would escalate on every page. Rule id +
 * node count is stable across both engines: a new rule, a removed rule or a
 * changed number of offending nodes still escalates.
 */
function a11yFingerprint(violations: A11yViolation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const nodes = Math.max(violation.nodes.length, 1);
    counts.set(violation.id, (counts.get(violation.id) ?? 0) + nodes);
  }
  return counts;
}

function fingerprintsMatch(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

function comparableToBaseline(input: FastDecisionInput): string | null {
  const { baseline, config, lighthouseVersion } = input;
  if (!baseline) return 'no comparable baseline';
  if (baseline.preset !== config.preset) return 'baseline preset changed';
  if (baseline.runs !== config.runs) return 'baseline run count changed';

  const baselineMajor = lighthouseMajor(baseline.lighthouseVersion);
  const currentMajor = lighthouseMajor(lighthouseVersion);
  if (baselineMajor !== null && currentMajor !== null && baselineMajor !== currentMajor) {
    return 'baseline was captured with a different Lighthouse major';
  }
  return null;
}

/**
 * Decides whether a measured page can be reported from the cheap pre-check.
 * The default is to escalate: every condition that could hide a real regression
 * sends the URL through the full Lighthouse pipeline instead.
 */
export function decideFastPath(input: FastDecisionInput): FastDecision {
  const { measurement, baseline, config } = input;
  const reasons: string[] = [];
  const enforcedBudgets: string[] = [];

  const timing = timingBudgetsConfigured(config.budgets);
  if (timing.length > 0) {
    reasons.push(`timing budgets need Lighthouse (${timing.join(', ')})`);
  }

  const comparability = comparableToBaseline(input);
  if (comparability) reasons.push(comparability);

  if (measurement.status === 0) reasons.push('no navigation response');
  else if (measurement.status >= 400) reasons.push(`navigation returned HTTP ${measurement.status}`);

  if (measurement.metrics.requests <= 0 || measurement.metrics.total <= 0) {
    reasons.push('no network profile captured');
  }

  if (baseline && comparability === null) {
    const current = a11yFingerprint(measurement.violations);
    const known = a11yFingerprint(baseline.violations);
    if (!fingerprintsMatch(current, known)) reasons.push('accessibility findings changed');
  }

  const a11yRule = config.budgets.a11y;
  const a11yConfigured =
    a11yRule !== undefined &&
    (a11yRule.maxViolations !== undefined ||
      a11yRule.maxNew !== undefined ||
      a11yRule.maxNewByImpact !== undefined);
  if (a11yConfigured) {
    enforcedBudgets.push('a11y');

    if (a11yRule.maxViolations !== undefined) {
      const total = measurement.metrics.violations;
      const near = a11yRule.maxViolations === 0 ? total > 0 : total >= a11yRule.maxViolations * 0.9;
      if (near) {
        reasons.push(
          total > a11yRule.maxViolations
            ? 'a11y violations exceed maxViolations'
            : 'a11y violations are within 10% of maxViolations',
        );
      }
    }
  }

  for (const key of SIZE_METRICS) {
    const rule = config.budgets[key];
    if (!rule || (rule.max === undefined && rule.regression === undefined)) continue;
    enforcedBudgets.push(key);

    const value = measurement.metrics[key];
    if (rule.max !== undefined) {
      // A metric within 10% of its ceiling can cross it between the cheap
      // snapshot and a full run, so confirm it with Lighthouse.
      const near = rule.max === 0 ? value > 0 : value >= rule.max * 0.9;
      if (near) {
        reasons.push(value > rule.max ? `${key} exceeds its max` : `${key} is within 10% of its max`);
      }
    }

    if (rule.regression !== undefined) {
      const baselineValue = baseline?.metrics[key];
      if (baselineValue === undefined || baselineValue <= 0) {
        reasons.push(`no comparable ${key} baseline`);
      } else {
        const deltaPct = ((value - baselineValue) / baselineValue) * 100;
        if (deltaPct > rule.regression) {
          reasons.push(`${key} regressed ${deltaPct.toFixed(1)}% (limit ${rule.regression}%)`);
        }
      }
    }
  }

  if (enforcedBudgets.length === 0) {
    reasons.push('no fast-checkable budgets configured');
  }

  return {
    useFast: reasons.length === 0,
    reasons: [...new Set(reasons)],
    enforcedBudgets,
  };
}

/** Builds the partial audit result the fast path can report honestly. */
export function fastAuditResult(
  measurement: FastMeasurement,
  config: { preset: Preset; runs: number },
  metricKeys: readonly string[],
  baseline?: AuditResult | null,
): AuditResult {
  const metrics = { ...emptyMetrics() };
  for (const key of SIZE_METRICS) metrics[key] = measurement.metrics[key];

  // The cheap path proves the rule/count set matches the baseline but axe and
  // Lighthouse generate different selectors. Reuse the baseline's node details
  // for the report so the a11y delta is not a false "everything is new"; a
  // mismatch never reaches here because decideFastPath escalates.
  const sameA11y =
    baseline !== undefined &&
    baseline !== null &&
    fingerprintsMatch(a11yFingerprint(measurement.violations), a11yFingerprint(baseline.violations));
  const violations = sameA11y ? baseline.violations : measurement.violations;
  metrics.violations = countViolationNodes({ violations });

  const enabled = new Set(metricKeys);
  const heaviest = [...measurement.requests].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  const thirdParty = measurement.requests.filter((request) => request.thirdParty);

  return {
    url: measurement.url,
    preset: config.preset,
    // The configured run count keeps the baseline comparable; the fast method is
    // a single snapshot and is marked on the report entry.
    runs: config.runs,
    capturedAt: new Date().toISOString(),
    metrics,
    heaviest: enabled.size > 0 ? heaviest : [],
    violations,
    thirdPartyHeaviest: thirdParty.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
  };
}

interface AxeBundle {
  source: string;
  version: string;
}

/** The bundled Lighthouse version, used to check baseline comparability. */
export function installedLighthouseVersion(): string | undefined {
  return LIGHTHOUSE_VERSION;
}

let axeBundle: Promise<AxeBundle> | undefined;

/**
 * Returns the exact axe bundle Lighthouse uses. It is imported lazily and
 * inlined at build time so a fast result cannot drift from the build that
 * produced the baseline, without loading 600 KB of axe for normal audits.
 */
function loadAxeBundle(): Promise<AxeBundle> {
  axeBundle ??= import('./axe.js').then(({ AXE_SOURCE, AXE_VERSION }) => ({
    source: AXE_SOURCE,
    version: AXE_VERSION,
  }));
  return axeBundle;
}

// Lighthouse's axe configuration (core/gather/gatherers/accessibility.js).
// Keeping the rule list identical is what makes a fast a11y result comparable
// to a stored Lighthouse result.
const AXE_RULES: Record<string, { enabled: boolean }> = {
  accesskeys: { enabled: true },
  'area-alt': { enabled: false },
  'aria-allowed-role': { enabled: true },
  'aria-braille-equivalent': { enabled: false },
  'aria-conditional-attr': { enabled: true },
  'aria-deprecated-role': { enabled: true },
  'aria-dialog-name': { enabled: true },
  'aria-prohibited-attr': { enabled: true },
  'aria-roledescription': { enabled: false },
  'aria-treeitem-name': { enabled: true },
  'aria-text': { enabled: true },
  'autocomplete-valid': { enabled: true },
  'audio-caption': { enabled: false },
  blink: { enabled: false },
  'duplicate-id': { enabled: false },
  'empty-heading': { enabled: true },
  'frame-focusable-content': { enabled: false },
  'frame-title-unique': { enabled: false },
  'heading-order': { enabled: true },
  'html-xml-lang-mismatch': { enabled: true },
  'identical-links-same-purpose': { enabled: true },
  'image-redundant-alt': { enabled: true },
  'input-button-name': { enabled: true },
  'label-content-name-mismatch': { enabled: true },
  'landmark-one-main': { enabled: true },
  'link-in-text-block': { enabled: true },
  marquee: { enabled: false },
  'meta-viewport': { enabled: true },
  'nested-interactive': { enabled: false },
  'no-autoplay-audio': { enabled: false },
  'presentation-role-conflict': { enabled: true },
  'role-img-alt': { enabled: false },
  'scrollable-region-focusable': { enabled: false },
  'select-name': { enabled: true },
  'server-side-image-map': { enabled: false },
  'skip-link': { enabled: true },
  'summary-name': { enabled: false },
  'svg-img-alt': { enabled: true },
  tabindex: { enabled: true },
  'table-duplicate-name': { enabled: true },
  'table-fake-caption': { enabled: true },
  'target-size': { enabled: true },
  'td-has-header': { enabled: true },
  'aria-tab-name': { enabled: false },
};

const AXE_OPTIONS = {
  elementRef: true,
  runOnly: { type: 'tag' as const, values: ['wcag2a', 'wcag2aa'] },
  resultTypes: ['violations', 'inapplicable'] as const,
  rules: AXE_RULES,
};

function isImpact(value: unknown): value is A11yImpact {
  return value === 'critical' || value === 'serious' || value === 'moderate' || value === 'minor';
}

interface AxeNodeResult {
  target?: string[];
  html?: string;
  impact?: string | null;
  failureSummary?: string;
  element?: { outerHTML?: unknown };
}

interface AxeViolationResult {
  id: string;
  help: string;
  impact?: string | null;
  nodes: AxeNodeResult[];
}

interface NetworkResponseEvent {
  requestId: string;
  type?: string;
  response?: { url?: string; status?: unknown };
}

interface NetworkLoadingFinishedEvent {
  requestId: string;
  encodedDataLength?: unknown;
}

interface Cdpsession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'Network.responseReceived', handler: (event: NetworkResponseEvent) => void): void;
  on(event: 'Network.loadingFinished', handler: (event: NetworkLoadingFinishedEvent) => void): void;
  detach?(): Promise<void>;
}

interface FastPage {
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<{ status(): number } | null>;
  waitForNetworkIdle?(options: { idleTime: number; timeout: number }): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  evaluate<T>(fn: (...args: unknown[]) => T, ...args: unknown[]): Promise<T>;
  createCDPSession(): Promise<Cdpsession>;
  close(): Promise<void>;
}

interface FastBrowser {
  newPage(): Promise<FastPage>;
  disconnect(): void;
}

interface PuppeteerModule {
  connect(options: { browserURL: string }): Promise<FastBrowser>;
}

function sameOrigin(candidate: string, pageUrl: string): boolean {
  try {
    return new URL(candidate).origin === new URL(pageUrl).origin;
  } catch {
    return true;
  }
}

function resourceBytes(
  responses: Map<string, { url: string; type: string; status: number }>,
  sizes: Map<string, number>,
  pageUrl: string,
): RequestSummary[] {
  const requests: RequestSummary[] = [];
  for (const [requestId, response] of responses) {
    if (!response.url || response.url.startsWith('data:')) continue;
    requests.push({
      url: response.url,
      resourceType: response.type || 'Other',
      bytes: sizes.get(requestId) ?? 0,
      thirdParty: !sameOrigin(response.url, pageUrl),
    });
  }
  return requests;
}

function sumBytes(requests: RequestSummary[], type?: string): number {
  return requests
    .filter((request) => type === undefined || request.resourceType.toLowerCase() === type.toLowerCase())
    .reduce((total, request) => total + request.bytes, 0);
}

export interface FastPrecheckOptions {
  url: string;
  chromePort: number;
  auth?: AuthConfig;
  timeoutMs: number;
}

export interface FastPrecheckResult {
  measurement: FastMeasurement;
  axeVersion: string;
}

/**
 * One cheap page load: network sizes plus axe. No Lighthouse trace, no
 * throttling simulation, no performance metrics.
 */
export async function measureFast(options: FastPrecheckOptions): Promise<FastPrecheckResult> {
  const puppeteerModule = (await import('puppeteer-core')) as unknown as {
    default: PuppeteerModule;
  };
  const axe = await loadAxeBundle();
  const browser = await puppeteerModule.default.connect({
    browserURL: `http://127.0.0.1:${options.chromePort}`,
  });

  try {
    const page = await browser.newPage();
    try {
      if (options.auth) await page.setExtraHTTPHeaders(resolveAuthHeaders(options.auth));

      const client = await page.createCDPSession();
      await client.send('Network.enable');
      const responses = new Map<string, { url: string; type: string; status: number }>();
      const sizes = new Map<string, number>();
      client.on('Network.responseReceived', (event) => {
        const response = event.response;
        if (response?.url === undefined || response.url.length === 0) return;
        responses.set(event.requestId, {
          url: response.url,
          type: event.type ?? 'Other',
          status: typeof response.status === 'number' ? response.status : 0,
        });
      });
      client.on('Network.loadingFinished', (event) => {
        sizes.set(event.requestId, Number(event.encodedDataLength ?? 0));
      });

      const response = await page.goto(options.url, {
        waitUntil: 'load',
        timeout: options.timeoutMs,
      });
      // Give late images/fonts a chance without waiting for a hung request.
      await page
        .waitForNetworkIdle?.({ idleTime: 500, timeout: Math.min(5_000, options.timeoutMs) })
        .catch(() => {
          // A late or hung request is not fatal for the cheap pre-check.
        });

      await page.evaluate(axe.source);
      const rawViolations = await page.evaluate(async (axeOptions: unknown) => {
        // This callback is serialized and runs in the page, where the CDP
        // browser globals exist but the Node tsconfig has no DOM lib.
        const globals = globalThis as unknown as {
          axe: {
            configure(options: Record<string, unknown>): void;
            run(context: unknown, options: unknown): Promise<{ violations: AxeViolationResult[] }>;
          };
          document: unknown;
        };
        const axeGlobal = globals.axe;
        axeGlobal.configure({ branding: { application: 'pulse-fast' }, noHtml: true });
        const results = await axeGlobal.run(globals.document, axeOptions);
        return results.violations.map((violation) => ({
          id: violation.id,
          help: violation.help,
          impact: violation.impact ?? null,
          nodes: violation.nodes.map((node) => ({
            target: Array.isArray(node.target) ? node.target.map(String) : [],
            html:
              typeof node.element?.outerHTML === 'string' ? node.element.outerHTML.slice(0, 500) : undefined,
            impact: node.impact ?? null,
            failureSummary: node.failureSummary,
          })),
        }));
      }, AXE_OPTIONS);

      const violations: A11yViolation[] = rawViolations.map((violation) => {
        const nodes: A11yNode[] = violation.nodes
          .map((node) => {
            const selector = node.target.at(0) ?? '';
            return {
              selector,
              snippet: node.html,
              impact: isImpact(node.impact) ? node.impact : undefined,
              failureSummary: node.failureSummary,
            };
          })
          .filter((node) => node.selector.length > 0);
        return {
          id: violation.id,
          title: violation.help,
          impact: isImpact(violation.impact) ? violation.impact : 'serious',
          nodes,
        };
      });

      const requests = resourceBytes(responses, sizes, options.url);
      const thirdParty = requests.filter((request) => request.thirdParty);
      const metrics = emptyMetrics();
      metrics.js = sumBytes(requests, 'Script');
      metrics.css = sumBytes(requests, 'Stylesheet');
      metrics.fonts = sumBytes(requests, 'Font');
      metrics.images = sumBytes(requests, 'Image');
      metrics.total = sumBytes(requests);
      metrics.requests = requests.length;
      metrics.thirdPartyBytes = sumBytes(thirdParty);
      metrics.thirdPartyRequests = thirdParty.length;
      metrics.violations = countViolationNodes({ violations });

      return {
        measurement: {
          url: options.url,
          status: response?.status() ?? 0,
          metrics,
          requests,
          violations,
        },
        axeVersion: axe.version,
      };
    } finally {
      await page.close();
    }
  } finally {
    browser.disconnect();
  }
}
