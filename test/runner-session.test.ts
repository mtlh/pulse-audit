import { describe, expect, it, vi } from 'vitest';
import { auditTargets, createAuditSession, type AuditTargetSpec } from '../src/runner.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeLhr(url: string): unknown {
  return {
    lighthouseVersion: '13.6.0',
    environment: { hostUserAgent: 'Chrome/140' },
    categories: { accessibility: { auditRefs: [] } },
    audits: {
      'largest-contentful-paint': { numericValue: 1000 },
      'cumulative-layout-shift': { numericValue: 0.01 },
      'total-blocking-time': { numericValue: 10 },
      'first-contentful-paint': { numericValue: 900 },
      'server-response-time': { numericValue: 100 },
      'network-requests': { details: { items: [{ url, resourceType: 'Document', transferSize: 100 }] } },
    },
  };
}

interface Harness {
  launchChrome: ReturnType<typeof vi.fn>;
  loadLighthouse: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    errors?: string[];
    delays?: Record<string, number>;
    lighthouseError?: Error;
  } = {},
): Harness {
  const kill = vi.fn(async () => {});
  const launchChrome = vi.fn(async () => ({ port: 9333, kill }));
  const lighthouse = vi.fn(async (url: string) => {
    if (options.lighthouseError) throw options.lighthouseError;
    if (options.errors?.includes(url)) throw new Error(`failed ${url}`);
    const wait = options.delays?.[url] ?? 0;
    if (wait > 0) await delay(wait);
    return { lhr: fakeLhr(url) };
  });
  const loadLighthouse = vi.fn(async () => ({
    default: lighthouse,
    defaultConfig: { categories: { performance: { auditRefs: [] } } },
  }));

  return { launchChrome, loadLighthouse, kill };
}

function target(url: string): AuditTargetSpec {
  return {
    url,
    options: { preset: 'mobile', runs: 1, warmup: 'none' },
  };
}

describe('audit session', () => {
  it('launches Chrome once and reuses it for every URL', async () => {
    const h = harness();
    const urls = ['https://a.example/', 'https://b.example/', 'https://c.example/'];
    const session = await createAuditSession({
      launchChrome: h.launchChrome as never,
      loadLighthouse: h.loadLighthouse as never,
    });

    const outcomes = await auditTargets(session, urls.map(target), { concurrency: 1 });
    await session.close();
    await session.close();

    expect(h.launchChrome).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(outcomes.map((outcome) => outcome.url)).toEqual(urls);
    expect(outcomes.every((outcome) => outcome.status === 'ok')).toBe(true);
  });

  it('keeps report order deterministic for sequential targets', async () => {
    const urls = ['https://slow.example/', 'https://fast.example/', 'https://middle.example/'];
    const h = harness({ delays: { [urls[0]]: 30, [urls[1]]: 5, [urls[2]]: 10 } });
    const session = await createAuditSession({
      launchChrome: h.launchChrome as never,
      loadLighthouse: h.loadLighthouse as never,
    });

    try {
      const outcomes = await auditTargets(session, urls.map(target), { concurrency: 1 });
      expect(outcomes.map((outcome) => outcome.url)).toEqual(urls);
    } finally {
      await session.close();
    }
  });

  it('isolates a failed URL and still closes the shared browser', async () => {
    const urls = ['https://ok.example/', 'https://bad.example/', 'https://also-ok.example/'];
    const h = harness({ errors: [urls[1]] });
    const session = await createAuditSession({
      launchChrome: h.launchChrome as never,
      loadLighthouse: h.loadLighthouse as never,
    });

    try {
      const outcomes = await auditTargets(session, urls.map(target), { concurrency: 1 });

      expect(outcomes[0].status).toBe('ok');
      expect(outcomes[1]).toMatchObject({ status: 'error', url: urls[1] });
      expect(outcomes[2].status).toBe('ok');
    } finally {
      await session.close();
    }

    expect(h.launchChrome).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  it('kills Chrome when the Lighthouse module fails to load after launch', async () => {
    const kill = vi.fn(async () => {});
    const launchChrome = vi.fn(async () => ({ port: 9333, kill }));
    const loadLighthouse = vi.fn(async () => {
      throw new Error('module boom');
    });

    await expect(
      createAuditSession({
        launchChrome: launchChrome,
        loadLighthouse: loadLighthouse,
      }),
    ).rejects.toThrow('module boom');

    expect(launchChrome).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
