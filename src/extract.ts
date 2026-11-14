import { countViolationNodes } from './compare.js';
import type {
  A11yImpact,
  A11yNode,
  A11yViolation,
  AuditResult,
  LcpElement,
  LongTaskDetail,
  Preset,
  RequestSummary,
} from './types.js';
import { IMPACT_ORDER } from './util/a11y.js';

/**
 * Lighthouse's LHR is enormous and changes shape between minor versions.
 * Keep every access defensive and verify the audit IDs against the installed
 * Lighthouse version before changing anything here.
 */
type Lhr = Record<string, any>;

export function isA11yImpact(value: unknown): value is A11yImpact {
  return value === 'critical' || value === 'serious' || value === 'moderate' || value === 'minor';
}

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

function sameOrigin(candidate: string, pageUrl: string): boolean {
  try {
    return new URL(candidate).origin === new URL(pageUrl).origin;
  } catch {
    return true;
  }
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

function sumBytes(requests: RequestSummary[], resourceType?: string): number {
  return requests
    .filter(
      (request) =>
        resourceType === undefined || request.resourceType.toLowerCase() === resourceType.toLowerCase(),
    )
    .reduce((total, request) => total + request.bytes, 0);
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

  return {
    url,
    preset,
    runs,
    capturedAt: new Date().toISOString(),
    lighthouseVersion: typeof lhr.lighthouseVersion === 'string' ? lhr.lighthouseVersion : undefined,
    chromeVersion:
      typeof lhr.environment?.hostUserAgent === 'string' ? lhr.environment.hostUserAgent : undefined,
    metrics: {
      lcp: numeric(lhr, 'largest-contentful-paint'),
      cls: numeric(lhr, 'cumulative-layout-shift'),
      tbt: numeric(lhr, 'total-blocking-time'),
      fcp: numeric(lhr, 'first-contentful-paint'),
      ttfb: numeric(lhr, 'server-response-time'),
      js: sumBytes(requests, 'Script'),
      css: sumBytes(requests, 'Stylesheet'),
      fonts: sumBytes(requests, 'Font'),
      images: sumBytes(requests, 'Image'),
      total: sumBytes(requests),
      requests: requests.length,
      failedRequests: failedRequests.length,
      thirdPartyBytes: sumBytes(thirdPartyRequests),
      thirdPartyRequests: thirdPartyRequests.length,
      longTasks: longTasks.count,
      violations: countViolationNodes({ violations }),
    },
    lcpElement: extractLcpElement(lhr),
    heaviest: [...requests].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    violations,
    thirdPartyHeaviest: [...thirdPartyRequests].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    ...(longTasks.details.length > 0 ? { longTaskDetails: longTasks.details } : {}),
    failedRequestDetails: failedRequests.slice(0, 10),
  };
}
