import { describe, expect, it } from 'vitest';
import { extractResult } from '../src/extract.js';

function lhr(): Record<string, any> {
  return {
    lighthouseVersion: '13.6.0',
    environment: { hostUserAgent: 'Mozilla/5.0 Chrome/126.0.0.0' },
    audits: {
      'largest-contentful-paint': { numericValue: 2500 },
      'cumulative-layout-shift': { numericValue: 0.12 },
      'total-blocking-time': { numericValue: 320 },
      'first-contentful-paint': { numericValue: 1500 },
      'server-response-time': { numericValue: 210 },
      'long-tasks': {
        details: {
          type: 'table',
          items: [
            { url: 'https://example.com/app.js', startTime: 100, duration: 300 },
            { url: 'https://cdn.example.net/lib.js', startTime: 450, duration: 60 },
            { url: 'https://example.com/app.js', startTime: 900, duration: 55 },
            { url: 'https://example.com/app.js', startTime: 1100, duration: 49.9 },
          ],
          debugData: {
            type: 'debugdata',
            urls: ['https://example.com/app.js', 'https://cdn.example.net/lib.js'],
            tasks: [
              { urlIndex: 0, startTime: 100, duration: 300 },
              { urlIndex: 1, startTime: 450, duration: 60 },
              { urlIndex: 0, startTime: 900, duration: 55 },
              { urlIndex: 0, startTime: 1100, duration: 49.9 },
            ],
          },
        },
      },
      'lcp-breakdown-insight': {
        details: {
          type: 'list',
          items: [
            { type: 'table', headings: [], items: [] },
            {
              type: 'node',
              selector: 'img.hero',
              snippet: '<img class="hero">',
              nodeLabel: 'Hero image',
            },
          ],
        },
      },
      'network-requests': {
        details: {
          items: [
            {
              url: 'https://example.com/app.js',
              resourceType: 'Script',
              transferSize: 1000,
              thirdParty: false,
            },
            {
              url: 'https://cdn.example.net/lib.js',
              resourceType: 'Script',
              transferSize: 5000,
              thirdParty: true,
            },
            { url: 'https://example.com/site.css', resourceType: 'Stylesheet', transferSize: 2000 },
            {
              url: 'https://fonts.example.net/font.woff2',
              resourceType: 'Font',
              transferSize: 7000,
              thirdParty: true,
            },
            {
              url: 'https://example.com/hero.png',
              resourceType: 'Image',
              transferSize: 3000,
              thirdParty: false,
            },
            {
              url: 'https://cdn.example.net/pixel.png',
              resourceType: 'Image',
              transferSize: 4000,
              thirdParty: true,
            },
          ],
        },
      },
      'color-contrast': {
        id: 'color-contrast',
        title: 'Elements must meet minimum color contrast ratio thresholds',
        score: 0,
        scoreDisplayMode: 'binary',
        details: {
          items: [
            {
              node: {
                selector: 'p.low',
                snippet: '<p class="low">',
                impact: 'moderate',
                failureSummary: 'Increase the contrast ratio.',
              },
            },
            {
              node: {
                selector: 'span.worse',
                snippet: '<span class="worse">',
                impact: 'critical',
                failureSummary: 'Increase the contrast ratio of the text.',
              },
            },
            { node: { selector: 'p.minor', impact: 'minor' } },
          ],
        },
      },
      'image-alt': {
        id: 'image-alt',
        title: 'Images must have alternate text',
        score: 0,
        scoreDisplayMode: 'binary',
        details: {
          items: [
            {
              node: {
                selector: 'img.pixel',
                snippet: '<img class="pixel">',
                impact: 'serious',
                failureSummary: 'Add an alt attribute.',
              },
            },
          ],
        },
      },
      'manual-check': {
        id: 'manual-check',
        title: 'Manual check',
        score: 0,
        scoreDisplayMode: 'manual',
        details: { items: [{ node: { selector: 'video' } }] },
      },
    },
    categories: {
      accessibility: {
        auditRefs: [
          { id: 'color-contrast' },
          { id: 'image-alt' },
          { id: 'manual-check' },
          { id: 'missing-audit' },
        ],
      },
    },
  };
}

describe('extractResult', () => {
  it('extracts every metric from the LHR', () => {
    const result = extractResult(lhr(), 'https://example.com/', 'mobile', 3);

    expect(result.metrics).toEqual({
      lcp: 2500,
      cls: 0.12,
      tbt: 320,
      fcp: 1500,
      ttfb: 210,
      js: 6000,
      css: 2000,
      fonts: 7000,
      images: 7000,
      total: 22_000,
      requests: 6,
      failedRequests: 0,
      thirdPartyBytes: 16_000,
      thirdPartyRequests: 3,
      longTasks: 3,
      violations: 4,
    });
    expect(result.lighthouseVersion).toBe('13.6.0');
    expect(result.chromeVersion).toContain('Chrome/126');
  });

  it('extracts the LCP element from the Lighthouse 13 insight node item', () => {
    const result = extractResult(lhr(), 'https://example.com/', 'mobile', 3);

    expect(result.lcpElement).toEqual({
      selector: 'img.hero',
      snippet: '<img class="hero">',
      url: undefined,
    });
  });

  it('falls back to the Lighthouse 12 LCP element audit shape', () => {
    const raw = lhr();
    delete raw.audits['lcp-breakdown-insight'];
    raw.audits['largest-contentful-paint-element'] = {
      details: {
        items: [
          {
            items: [
              {
                node: {
                  selector: 'img.legacy',
                  snippet: '<img class="legacy">',
                  url: 'https://example.com/legacy.png',
                },
              },
            ],
          },
        ],
      },
    };

    const result = extractResult(raw, 'https://example.com/', 'mobile', 3);

    expect(result.lcpElement).toEqual({
      selector: 'img.legacy',
      snippet: '<img class="legacy">',
      url: 'https://example.com/legacy.png',
    });
  });

  it('counts error responses and aborted requests, but not redirects', () => {
    const raw = lhr();
    raw.audits['network-requests'].details.items = [
      { url: 'https://example.com/', resourceType: 'Document', statusCode: 200, finished: true },
      { url: 'https://example.com/old', resourceType: 'Document', statusCode: 301, finished: true },
      {
        url: 'https://example.com/missing.png',
        resourceType: 'Image',
        statusCode: 404,
        finished: true,
        transferSize: 120,
      },
      { url: 'https://api.example.com/data', resourceType: 'Fetch', statusCode: 500, finished: true },
      { url: 'https://cdn.example.net/tracker', resourceType: 'XHR', finished: false },
    ];

    const result = extractResult(raw, 'https://example.com/', 'mobile', 3);

    expect(result.metrics.failedRequests).toBe(3);
    expect(result.failedRequestDetails?.map((request) => request.url)).toEqual([
      'https://example.com/missing.png',
      'https://api.example.com/data',
      'https://cdn.example.net/tracker',
    ]);
    expect(result.failedRequestDetails?.[0]).toMatchObject({
      resourceType: 'Image',
      statusCode: 404,
      failed: true,
    });
    expect(result.failedRequestDetails?.[1]?.statusCode).toBe(500);
    expect(result.failedRequestDetails?.[2]?.statusCode).toBeUndefined();
    expect(result.failedRequestDetails?.[2]?.failed).toBe(true);
  });

  it('keeps the first 10 failed requests in the detail list', () => {
    const raw = lhr();
    raw.audits['network-requests'].details.items = Array.from({ length: 12 }, (_, index) => ({
      url: `https://example.com/missing-${index}.js`,
      resourceType: 'Script',
      statusCode: 404,
      finished: true,
    }));

    const result = extractResult(raw, 'https://example.com/', 'mobile', 3);

    expect(result.metrics.failedRequests).toBe(12);
    expect(result.failedRequestDetails).toHaveLength(10);
    expect(result.failedRequestDetails?.[9]?.url).toBe('https://example.com/missing-9.js');
  });

  it('keeps the heaviest request lists, with third parties sorted separately', () => {
    const result = extractResult(lhr(), 'https://example.com/', 'mobile', 3);

    expect(result.heaviest.map((request) => request.url)).toEqual([
      'https://fonts.example.net/font.woff2',
      'https://cdn.example.net/lib.js',
      'https://cdn.example.net/pixel.png',
      'https://example.com/hero.png',
      'https://example.com/site.css',
      'https://example.com/app.js',
    ]);
    expect(result.thirdPartyHeaviest?.map((request) => request.bytes)).toEqual([7000, 5000, 4000]);
    expect(result.thirdPartyHeaviest?.every((request) => request.thirdParty)).toBe(true);
  });

  it('keeps per-node impact and failureSummary and uses the worst node impact', () => {
    const result = extractResult(lhr(), 'https://example.com/', 'mobile', 3);
    const contrast = result.violations.find((violation) => violation.id === 'color-contrast');

    expect(contrast?.impact).toBe('critical');
    expect(contrast?.nodes).toHaveLength(3);
    expect(contrast?.nodes[0]).toEqual({
      selector: 'p.low',
      snippet: '<p class="low">',
      impact: 'moderate',
      failureSummary: 'Increase the contrast ratio.',
    });
    expect(contrast?.nodes[2].impact).toBe('minor');

    const image = result.violations.find((violation) => violation.id === 'image-alt');
    expect(image?.impact).toBe('serious');
    expect(image?.nodes[0].failureSummary).toBe('Add an alt attribute.');
    expect(result.violations.map((violation) => violation.id)).toEqual(['color-contrast', 'image-alt']);
  });

  it('defaults a violation impact to serious when no node reports one', () => {
    const raw = lhr();
    raw.audits['color-contrast'].details.items = [{ node: { selector: 'p.low' } }];

    const result = extractResult(raw, 'https://example.com/', 'mobile', 3);
    const contrast = result.violations.find((violation) => violation.id === 'color-contrast');
    expect(contrast?.impact).toBe('serious');
    expect(contrast?.nodes[0].impact).toBeUndefined();
  });

  it('is defensive about missing audits and malformed requests', () => {
    const result = extractResult({}, 'https://example.com/', 'desktop', 1);

    expect(result.metrics).toEqual({
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
      violations: 0,
    });
    expect(result.heaviest).toEqual([]);
    expect(result.thirdPartyHeaviest).toEqual([]);
    expect(result.lcpElement).toBeUndefined();
    expect(result.longTaskDetails).toBeUndefined();
  });

  it('counts long tasks from debugData and maps urlIndex to the attributed URL', () => {
    const result = extractResult(lhr(), 'https://example.com/', 'mobile', 3);

    expect(result.metrics.longTasks).toBe(3);
    expect(result.longTaskDetails).toEqual([
      { url: 'https://example.com/app.js', startTime: 100, duration: 300 },
      { url: 'https://cdn.example.net/lib.js', startTime: 450, duration: 60 },
      { url: 'https://example.com/app.js', startTime: 900, duration: 55 },
    ]);
  });

  it('keeps only the five longest tasks in the detail list', () => {
    const raw = lhr();
    raw.audits['long-tasks'].details.debugData = {
      urls: ['https://example.com/app.js'],
      tasks: Array.from({ length: 7 }, (_, index) => ({
        urlIndex: 0,
        startTime: index * 100,
        duration: 60 + index * 10,
      })),
    };

    const result = extractResult(raw, 'https://example.com/', 'mobile', 1);
    expect(result.metrics.longTasks).toBe(7);
    expect(result.longTaskDetails?.map((task) => task.duration)).toEqual([120, 110, 100, 90, 80]);
    expect(result.longTaskDetails?.every((task) => task.url === 'https://example.com/app.js')).toBe(true);
  });

  it('falls back to details.items and filters sub-50ms or malformed tasks', () => {
    const raw = lhr();
    delete raw.audits['long-tasks'].details.debugData;
    raw.audits['long-tasks'].details.items = [
      { url: 'https://example.com/late.js', startTime: 200, duration: 180 },
      { url: 'https://example.com/short.js', startTime: 400, duration: 49 },
      { url: 'https://example.com/string.js', startTime: 600, duration: '900' },
    ];

    const result = extractResult(raw, 'https://example.com/', 'mobile', 3);
    expect(result.metrics.longTasks).toBe(1);
    expect(result.longTaskDetails).toEqual([
      { url: 'https://example.com/late.js', startTime: 200, duration: 180 },
    ]);
  });

  it('reports no long tasks when the audit is absent or not applicable', () => {
    const raw = lhr();
    raw.audits['long-tasks'] = { scoreDisplayMode: 'notApplicable', details: { items: [] } };

    const notApplicable = extractResult(raw, 'https://example.com/', 'mobile', 1);
    expect(notApplicable.metrics.longTasks).toBe(0);
    expect(notApplicable.longTaskDetails).toBeUndefined();

    const missing = extractResult({}, 'https://example.com/', 'mobile', 1);
    expect(missing.metrics.longTasks).toBe(0);
    expect(missing.longTaskDetails).toBeUndefined();
  });

  it('falls back to origin comparison when thirdParty is absent', () => {
    const raw = lhr();
    raw.audits['network-requests'].details.items = [
      { url: 'https://example.com/local.js', resourceType: 'Script', transferSize: 10 },
      { url: 'https://cdn.other.net/remote.js', resourceType: 'Script', transferSize: 20 },
    ];

    const result = extractResult(raw, 'https://example.com/', 'mobile', 1);
    expect(result.metrics.thirdPartyBytes).toBe(20);
    expect(result.metrics.thirdPartyRequests).toBe(1);
  });
});
