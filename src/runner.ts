import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { extractResult } from './extract.js';
import type { AuditResult, PulseConfig } from './types.js';
import { median } from './util/median.js';

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

/**
 * Picks the run with the median LCP and uses its detail data (LCP element,
 * request list, violations). Numeric metrics are medianed across all runs.
 */
export function pickMedianRun(results: AuditResult[]): AuditResult {
  if (results.length === 0) throw new Error('No audit runs to pick from');
  if (results.length === 1) return results[0];

  const byLcp = [...results].sort((a, b) => a.metrics.lcp - b.metrics.lcp);
  const chosen = byLcp[Math.floor(byLcp.length / 2)];

  return {
    ...chosen,
    metrics: {
      ...chosen.metrics,
      lcp: median(results.map((result) => result.metrics.lcp)),
      cls: median(results.map((result) => result.metrics.cls)),
      tbt: median(results.map((result) => result.metrics.tbt)),
      js: median(results.map((result) => result.metrics.js)),
      images: median(results.map((result) => result.metrics.images)),
      requests: median(results.map((result) => result.metrics.requests)),
      // Keep the count tied to the violation array actually included in the report.
      violations: chosen.metrics.violations,
    },
  };
}

export async function runAudit(url: string, config: PulseConfig): Promise<AuditResult> {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const results: AuditResult[] = [];
    const totalRuns = config.runs + WARMUP_RUNS;

    for (let run = 0; run < totalRuns; run += 1) {
      const runner = await lighthouse(url, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility'],
        formFactor: config.preset,
        screenEmulation: config.preset === 'mobile' ? MOBILE_SCREEN : DESKTOP_SCREEN,
        throttling: config.preset === 'mobile' ? MOBILE_THROTTLING : DESKTOP_THROTTLING,
        throttlingMethod: 'simulate',
        maxWaitForLoad: 45_000,
      } as any);

      if (!runner) throw new Error(`Lighthouse returned no result for ${url}`);
      if (run < WARMUP_RUNS) continue;

      results.push(extractResult(runner.lhr as any, url, config.preset, config.runs));
    }

    return pickMedianRun(results);
  } finally {
    await chrome.kill();
  }
}
