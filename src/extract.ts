import { countViolationNodes } from './compare.js';
import { auditMetrics } from './metrics.js';
import type {
  A11yImpact,
  A11yNode,
  A11yViolation,
  AuditResult,
  ConsoleError,
  LcpElement,
  LongTaskDetail,
  Preset,
  RequestSummary,
  ThirdPartyCpu,
} from './types.js';
import { IMPACT_ORDER, isA11yImpact } from './util/a11y.js';
import { sameOrigin, sumRequestBytes } from './util/requests.js';

/**
 * Lighthouse's LHR is enormous and changes shape between minor versions.
 * Keep every access defensive and verify the audit IDs against the installed
 * Lighthouse version before changing anything here.
 */
type Lhr = Record<string, any>;

export { isA11yImpact };

/** Worst (most severe) impact, defaulting to `serious` like axe/Lighthouse. */
export function worstImpact(impacts: Array<A11yImpact | undefined>): A11yImpact {
  for (const impact of IMPACT_ORDER) {
    if (impacts.includes(impact)) return impact;
  }
  return 'serious';
}

function numeric(lhr: Lhr, auditId: string): number {
  const value = lhr.audits?.[auditId]?.numericValue;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Lighthouse's long-task threshold; sub-50 ms tasks are not "long". */
const LONG_TASK_THRESHOLD_MS = 50;
const LONG_TASK_DETAIL_LIMIT = 5;

/**
 * Counts main-thread tasks of at least 50 ms. Lighthouse's `long-tasks` audit
 * has no `numericValue`, so the count comes from the task list itself. The
 * `debugData.tasks` list is complete and carries `urlIndex` into
 * `debugData.urls`; `details.items` is only the top 20 and is kept as a
 * fallback for older LHR shapes.
 */
function extractLongTasks(lhr: Lhr): { count: number; details: LongTaskDetail[] } {
  const details = lhr.audits?.['long-tasks']?.details;
  const debugData = details?.debugData;
  const urls: unknown[] = Array.isArray(debugData?.urls) ? debugData.urls : [];
  const debugTasks: any[] = Array.isArray(debugData?.tasks) ? debugData.tasks : [];
  const itemTasks: any[] = Array.isArray(details?.items) ? details.items : [];
  // Prefer the complete list; fall back when a stored/older LHR has only items.
  const rawTasks = debugTasks.length > 0 ? debugTasks : itemTasks;

  const tasks: LongTaskDetail[] = [];
  for (const task of rawTasks) {
    const duration = finiteNumber(task?.duration);
    if (duration === undefined || duration < LONG_TASK_THRESHOLD_MS) continue;

    const urlIndex = finiteNumber(task?.urlIndex);
    const indexedUrl = urlIndex === undefined ? undefined : urls[urlIndex];
    const attributed =
      typeof task?.url === 'string' && task.url.length > 0
        ? task.url
        : typeof indexedUrl === 'string' && indexedUrl.length > 0
          ? indexedUrl
          : undefined;

    tasks.push({
      url: attributed,
      startTime: finiteNumber(task?.startTime) ?? 0,
      duration,
    });
  }

  return {
    count: tasks.length,
    details: [...tasks].sort((a, b) => b.duration - a.duration).slice(0, LONG_TASK_DETAIL_LIMIT),
  };
}

function extractRequests(lhr: Lhr, pageUrl: string): RequestSummary[] {
  const items: any[] = lhr.audits?.['network-requests']?.details?.items ?? [];
  return items
    .filter((item) => typeof item?.url === 'string')
    .map((item) => {
      const statusCode = typeof item.statusCode === 'number' ? item.statusCode : undefined;
      return {
        url: item.url as string,
        resourceType: (item.resourceType as string) ?? 'Other',
        bytes: Number(item.transferSize ?? item.resourceSize ?? 0),
        thirdParty: typeof item.thirdParty === 'boolean' ? item.thirdParty : !sameOrigin(item.url, pageUrl),
        statusCode,
        // Redirects are not failures; only an error response or a request that
        // never finished counts as a failed subresource.
        failed: (statusCode !== undefined && statusCode >= 400) || item.finished === false,
      };
    });
}

function isFailedRequest(request: RequestSummary): boolean {
  return request.failed === true;
}

function extractLcpElement(lhr: Lhr): LcpElement | undefined {
  // Lighthouse 13 exposes the element as a node item in the lcp-breakdown
  // insight list. Lighthouse 12 used a dedicated audit instead, kept here so
  // older LHR fixtures and stored reports still resolve.
  const insightDetails = lhr.audits?.['lcp-breakdown-insight']?.details;
  const insightItems: any[] = Array.isArray(insightDetails?.items) ? insightDetails.items : [];
  const insightNode = insightItems.find((item) => item?.type === 'node');

  // Shape in Lighthouse 12: details.items[0].items[0].node
  const legacyDetails = lhr.audits?.['largest-contentful-paint-element']?.details;
  const nested = legacyDetails?.items?.[0]?.items?.[0]?.node;
  const flat = legacyDetails?.items?.[0]?.node;
  const node = insightNode ?? nested ?? flat;
  if (!node) return undefined;

  const selector = node.selector ?? node.nodeLabel ?? '';
  if (!selector) return undefined;

  return {
    selector,
    url: typeof node.url === 'string' ? node.url : undefined,
    snippet: typeof node.snippet === 'string' ? node.snippet : undefined,
  };
}

function entityName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const entity = value as Record<string, unknown>;
    if (typeof entity.text === 'string') return entity.text;
    if (typeof entity.name === 'string') return entity.name;
    if (typeof entity.url === 'string') return entity.url;
  }
  return '';
}

/**
 * Lighthouse 13 reports third-party CPU in the `third-parties-insight` table.
 * Older and stored LHRs use `third-party-summary`, which also carries a
 * blocking time for entities without a main-thread measurement.
 */
function thirdPartyCpuItems(lhr: Lhr): ThirdPartyCpu[] | undefined {
  const insightItems: unknown = lhr.audits?.['third-parties-insight']?.details?.items;
  if (Array.isArray(insightItems)) {
    return insightItems.map((item: any) => ({
      entity: entityName(item?.entity),
      mainThreadTime: finiteNumber(item?.mainThreadTime) ?? 0,
      transferSize: finiteNumber(item?.transferSize) ?? 0,
    }));
  }

  const fallbackItems: unknown = lhr.audits?.['third-party-summary']?.details?.items;
  if (!Array.isArray(fallbackItems)) return undefined;
  return fallbackItems.map((item: any) => ({
    entity: entityName(item?.entity),
    mainThreadTime: finiteNumber(item?.mainThreadTime) ?? finiteNumber(item?.blockingTime) ?? 0,
    transferSize: finiteNumber(item?.transferSize) ?? 0,
  }));
}

function normalizeConsoleDescription(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Lighthouse reports one table row per console error, so the same message can
 * repeat when a script fails in a loop. Pulse counts unique normalized
 * descriptions and keeps the first source location it saw for each.
 */
export function extractConsoleErrors(lhr: Lhr): ConsoleError[] {
  const audit = lhr.audits?.['errors-in-console'];
  if (!audit || audit.scoreDisplayMode === 'notApplicable') return [];

  const items: any[] = Array.isArray(audit.details?.items) ? audit.details.items : [];
  const seen = new Set<string>();
  const errors: ConsoleError[] = [];

  for (const item of items) {
    const description = normalizeConsoleDescription(item?.description);
    if (!description || seen.has(description)) continue;
    seen.add(description);

    const location = item?.sourceLocation;
    errors.push({
      description,
      url: typeof location?.url === 'string' ? location.url : undefined,
      line: typeof location?.line === 'number' ? location.line : undefined,
      column: typeof location?.column === 'number' ? location.column : undefined,
    });
  }

  return errors;
}

function extractViolations(lhr: Lhr): A11yViolation[] {
  const refs: any[] = lhr.categories?.accessibility?.auditRefs ?? [];
  const violations: A11yViolation[] = [];

  for (const ref of refs) {
    const audit = lhr.audits?.[ref.id];
    if (!audit) continue;
    if (['notApplicable', 'manual', 'informative'].includes(audit.scoreDisplayMode)) continue;
    if (typeof audit.score !== 'number' || audit.score >= 1) continue;

    const items: any[] = audit.details?.items ?? [];
    const nodes: A11yNode[] = items
      .map((item) => {
        const rawImpact = item?.node?.impact ?? item?.impact;
        const failureSummary = item?.node?.failureSummary ?? item?.failureSummary;
        return {
          selector: (item?.node?.selector ?? item?.selector ?? '') as string,
          snippet: (item?.node?.snippet ?? item?.snippet ?? undefined) as string | undefined,
          impact: isA11yImpact(rawImpact) ? rawImpact : undefined,
          failureSummary:
            typeof failureSummary === 'string' && failureSummary.trim().length > 0
              ? failureSummary
              : undefined,
        };
      })
      .filter((node) => node.selector.length > 0);

    violations.push({
      id: (audit.id ?? ref.id) as string,
      title: (audit.title ?? ref.id) as string,
      impact: worstImpact(nodes.map((node) => node.impact)),
      nodes,
    });
  }

  return violations;
}

export function extractResult(lhr: Lhr, url: string, preset: Preset, runs: number): AuditResult {
  const requests = extractRequests(lhr, url);
  const violations = extractViolations(lhr);
  const thirdPartyRequests = requests.filter((request) => request.thirdParty);
  const longTasks = extractLongTasks(lhr);
  const failedRequests = requests.filter(isFailedRequest);
  const thirdPartyCpuAll = thirdPartyCpuItems(lhr) ?? [];
  const thirdPartyMainThread = thirdPartyCpuAll.reduce((total, item) => total + item.mainThreadTime, 0);
  const consoleErrors = extractConsoleErrors(lhr);

  return {
    url,
    preset,
    runs,
    capturedAt: new Date().toISOString(),
    lighthouseVersion: typeof lhr.lighthouseVersion === 'string' ? lhr.lighthouseVersion : undefined,
    chromeVersion:
      typeof lhr.environment?.hostUserAgent === 'string' ? lhr.environment.hostUserAgent : undefined,
    metrics: auditMetrics({
      lcp: numeric(lhr, 'largest-contentful-paint'),
      cls: numeric(lhr, 'cumulative-layout-shift'),
      tbt: numeric(lhr, 'total-blocking-time'),
      fcp: numeric(lhr, 'first-contentful-paint'),
      ttfb: numeric(lhr, 'server-response-time'),
      js: sumRequestBytes(requests, 'Script'),
      css: sumRequestBytes(requests, 'Stylesheet'),
      fonts: sumRequestBytes(requests, 'Font'),
      images: sumRequestBytes(requests, 'Image'),
      total: sumRequestBytes(requests),
      requests: requests.length,
      failedRequests: failedRequests.length,
      thirdPartyBytes: sumRequestBytes(thirdPartyRequests),
      thirdPartyRequests: thirdPartyRequests.length,
      longTasks: longTasks.count,
      thirdPartyMainThread,
      consoleErrors: consoleErrors.length,
      violations: countViolationNodes({ violations }),
    }),
    lcpElement: extractLcpElement(lhr),
    heaviest: [...requests].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    violations,
    thirdPartyHeaviest: [...thirdPartyRequests].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    ...(longTasks.details.length > 0 ? { longTaskDetails: longTasks.details } : {}),
    failedRequestDetails: failedRequests.slice(0, 10),
    thirdPartyCpu: [...thirdPartyCpuAll].sort((a, b) => b.mainThreadTime - a.mainThreadTime).slice(0, 10),
    consoleErrorDetails: consoleErrors.length > 0 ? consoleErrors.slice(0, 10) : undefined,
  };
}
