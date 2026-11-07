import { resolveRequestHeaders } from './auth.js';
import type { ApiMetrics, ApiResult, ResolvedApiTarget } from './types.js';
import { median } from './util/median.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A cancelled or timed-out request is an audit error, not a slow sample: there
 * is no trustworthy TTFB or byte count to record. Other runs are retried.
 */
async function measureOnce(
  target: ResolvedApiTarget,
  headers: Record<string, string>,
  runNumber: number,
): Promise<ApiMetrics> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= target.retries + 1; attempt += 1) {
    try {
      const started = performance.now();
      const response = await fetch(target.url, {
        method: target.method,
        headers,
        body: target.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(target.timeoutMs),
      });
      const ttfb = performance.now() - started;
      const bytes = (await response.arrayBuffer()).byteLength;
      const duration = performance.now() - started;

      return { ttfb, duration, bytes, status: response.status };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `API request failed for ${target.method} ${target.url} on run ${runNumber} after ${
      target.retries + 1
    } attempt(s): ${message(lastError)}`,
  );
}

/**
 * The representative status comes from the median-duration run. TTFB,
 * duration and bytes are medians across every measured run.
 */
export function pickMedianApiSample(samples: ApiMetrics[]): ApiMetrics {
  if (samples.length === 0) throw new Error('No API runs to pick from');

  const byDuration = [...samples].sort((a, b) => a.duration - b.duration);
  const representative = byDuration[Math.floor(byDuration.length / 2)];

  return {
    ttfb: median(samples.map((sample) => sample.ttfb)),
    duration: median(samples.map((sample) => sample.duration)),
    bytes: median(samples.map((sample) => sample.bytes)),
    status: representative.status,
  };
}

/**
 * Measures one API endpoint. Unlike Lighthouse pages there is no discarded
 * warm-up: `runs` requests are executed, so POST/PUT/DELETE targets re-run
 * their side effect. Use `runs: 1` for unsafe methods when that matters.
 */
export async function runApiAudit(
  target: ResolvedApiTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiResult> {
  if (!Number.isInteger(target.runs) || target.runs < 1) {
    throw new Error(`API runs must be a positive integer, received ${target.runs}`);
  }

  const headers = resolveRequestHeaders(target.auth, target.headers, env);
  const samples: ApiMetrics[] = [];

  for (let run = 1; run <= target.runs; run += 1) {
    samples.push(await measureOnce(target, headers, run));
  }

  return {
    url: target.url,
    method: target.method,
    runs: target.runs,
    capturedAt: new Date().toISOString(),
    metrics: pickMedianApiSample(samples),
    samples,
  };
}
