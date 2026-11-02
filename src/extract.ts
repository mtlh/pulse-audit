import { countViolationNodes } from './compare.js';
import type {
  A11yImpact,
  A11yNode,
  A11yViolation,
  AuditResult,
  LcpElement,
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
    .map((item) => ({
      url: item.url as string,
      resourceType: (item.resourceType as string) ?? 'Other',
      bytes: Number(item.transferSize ?? item.resourceSize ?? 0),
      thirdParty: typeof item.thirdParty === 'boolean' ? item.thirdParty : !sameOrigin(item.url, pageUrl),
    }));
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
  // Shape in Lighthouse 12: details.items[0].items[0].node
  const details = lhr.audits?.['largest-contentful-paint-element']?.details;
  const nested = details?.items?.[0]?.items?.[0]?.node;
  const flat = details?.items?.[0]?.node;
  const node = nested ?? flat;
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
      thirdPartyBytes: sumBytes(thirdPartyRequests),
      thirdPartyRequests: thirdPartyRequests.length,
      violations: countViolationNodes({ violations }),
    },
    lcpElement: extractLcpElement(lhr),
    heaviest: [...requests].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    violations,
    thirdPartyHeaviest: [...thirdPartyRequests].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
  };
}
