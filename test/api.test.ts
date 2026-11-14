import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickMedianApiSample, runApiAudit } from '../src/api.js';
import { compareApiResult, expectedStatus } from '../src/compare.js';
import type { ApiMetrics, ApiResult, ResolvedApiTarget } from '../src/types.js';

interface TestServer {
  url: string;
  close(): Promise<void>;
}

const TOKEN = 'test-token';
const USER = 'pulse';
const PASS = 'secret';

function target(url: string, overrides: Partial<ResolvedApiTarget> = {}): ResolvedApiTarget {
  return {
    url,
    method: 'GET',
    runs: 1,
    retries: 0,
    timeoutMs: 5000,
    budgets: {},
    ...overrides,
  };
}

function apiResult(overrides: Partial<ApiResult> = {}): ApiResult {
  return {
    url: 'https://api.example.com/items',
    method: 'GET',
    runs: 1,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: { ttfb: 100, duration: 200, bytes: 1024, status: 200 },
    ...overrides,
  };
}

async function startServer(): Promise<TestServer> {
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/private') {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"error":"unauthorized"}');
        return;
      }
      const body = JSON.stringify({ ok: true, padding: 'x'.repeat(256) });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }

    if (pathname === '/basic') {
      const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('unauthorized');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }

    if (pathname === '/echo') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        const payload = JSON.stringify({
          method: request.method,
          body,
          auth: request.headers.authorization ?? null,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(payload);
      });
      return;
    }

    if (pathname === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

describe('runApiAudit', () => {
  let site: TestServer;

  beforeAll(async () => {
    site = await startServer();
  });

  afterAll(async () => {
    await site.close();
  });

  it('measures TTFB, duration, status and bytes for an authenticated request', async () => {
    const result = await runApiAudit(
      target(`${site.url}/private`, {
        auth: { type: 'bearer', token: '${PULSE_API_TOKEN}' },
      }),
      { PULSE_API_TOKEN: TOKEN },
    );

    expect(result.method).toBe('GET');
    expect(result.runs).toBe(1);
    expect(result.metrics.status).toBe(200);
    expect(result.metrics.bytes).toBeGreaterThan(256);
    expect(result.metrics.ttfb).toBeGreaterThan(0);
    expect(result.metrics.duration).toBeGreaterThanOrEqual(result.metrics.ttfb);
    expect(result.samples).toHaveLength(1);
    // The request body and auth header are never stored.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  }, 15_000);

  it('supports basic auth', async () => {
    const result = await runApiAudit(
      target(`${site.url}/basic`, {
        auth: { type: 'basic', username: USER, password: PASS },
      }),
    );

    expect(result.metrics.status).toBe(200);
  });

  it('sends a method, body and custom headers', async () => {
    const result = await runApiAudit(
      target(`${site.url}/echo`, {
        method: 'POST',
        body: '{"hello":"world"}',
        headers: { 'content-type': 'application/json', 'x-run': 'test' },
      }),
    );

    expect(result.metrics.status).toBe(200);
    expect(result.method).toBe('POST');
  });

  it('medians runs and takes the status from the median-duration run', async () => {
    const result = await runApiAudit(target(`${site.url}/ok`, { runs: 2 }));
    expect(result.samples).toHaveLength(2);
    expect(result.metrics.status).toBe(200);
  });

  it('fails clearly when the environment variable for a secret is missing', async () => {
    await expect(
      runApiAudit(
        target(`${site.url}/private`, {
          auth: { type: 'bearer', token: '${DEFINITELY_NOT_SET_IN_THIS_TEST}' },
        }),
        {},
      ),
    ).rejects.toThrow(/DEFINITELY_NOT_SET_IN_THIS_TEST/);
  });
});

describe('pickMedianApiSample', () => {
  it('medians each metric and keeps the representative status', () => {
    const samples: ApiMetrics[] = [
      { ttfb: 10, duration: 100, bytes: 100, status: 200 },
      { ttfb: 20, duration: 200, bytes: 200, status: 201 },
      { ttfb: 30, duration: 300, bytes: 300, status: 202 },
    ];

    expect(pickMedianApiSample(samples)).toEqual({
      ttfb: 20,
      duration: 200,
      bytes: 200,
      status: 201,
    });
  });
});

describe('compareApiResult', () => {
  it('gates latency budgets and reports status', () => {
    const baseline = apiResult({ metrics: { ttfb: 100, duration: 200, bytes: 1024, status: 200 } });
    const current = apiResult({ metrics: { ttfb: 150, duration: 260, bytes: 1024, status: 200 } });

    const checks = compareApiResult(current, baseline, {
      budgets: {
        ttfb: { max: 140, regression: 10 },
        duration: { max: 250, regression: 10 },
        bytes: { max: 1200 },
      },
    });

    expect(checks.find((check) => check.metric === 'ttfb')?.status).toBe('fail');
    expect(checks.find((check) => check.metric === 'duration')?.status).toBe('fail');
    expect(checks.find((check) => check.metric === 'bytes')?.status).toBe('pass');
    expect(checks.find((check) => check.metric === 'status')).toMatchObject({
      status: 'pass',
      value: 200,
    });
  });

  it('warns on an unexpected status by default and fails an explicit mismatch', () => {
    const missing = apiResult({ metrics: { ttfb: 100, duration: 200, bytes: 10, status: 404 } });

    const warn = compareApiResult(missing, null, { budgets: {} });
    expect(warn.find((check) => check.metric === 'status')?.status).toBe('warn');

    const fail = compareApiResult(missing, null, { budgets: {}, expectStatus: 200 });
    expect(fail.find((check) => check.metric === 'status')?.status).toBe('fail');
  });

  it('accepts a list of expected statuses', () => {
    expect(expectedStatus(201, [200, 201])).toBe(true);
    expect(expectedStatus(202, [200, 201])).toBe(false);
    expect(expectedStatus(302)).toBe(true);
    expect(expectedStatus(500)).toBe(false);
  });
});
