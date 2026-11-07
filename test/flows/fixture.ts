import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Deterministic local site used by the end-to-end flows.
 *
 * It deliberately has:
 * - a large hero image that is not preloaded (LCP / image weight),
 * - an element injected after load that shifts layout (CLS),
 * - an image without alt text and low-contrast copy (axe),
 * - a ~220 KB script (JS weight).
 *
 * There are no external requests, fixed dimensions, and no compression, so
 * transfer sizes are stable between runs.
 */
export interface FixtureSite {
  url: string;
  /** Toggle an extra a11y violation or require auth between audit runs. */
  state: { extraViolation: boolean; requireAuth: boolean };
  close(): Promise<void>;
}

export const fixtureAuth = {
  token: 'pulse-test-token',
  username: 'pulse',
  password: 'secret',
} as const;

const HERO_BYTES = 160 * 1024;
const SCRIPT_BYTES = 220 * 1024;

function isAuthorized(request: { headers: { authorization?: string } }): boolean {
  const header = request.headers.authorization;
  if (header === `Bearer ${fixtureAuth.token}`) return true;
  const basic = `Basic ${Buffer.from(`${fixtureAuth.username}:${fixtureAuth.password}`).toString('base64')}`;
  return header === basic;
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function heroSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#175cd3"/><stop offset="1" stop-color="#067647"/>
  </linearGradient></defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <!-- ${'hero-padding '.repeat(Math.ceil(HERO_BYTES / 13))} -->
</svg>`;
}

function pixelSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#b42318"/></svg>';
}

function heavyScript(): string {
  return `/* ${'weight-padding '.repeat(Math.ceil(SCRIPT_BYTES / 15))} */\nwindow.__pulseFixtureLoaded = true;\n`;
}

function html(extraViolation: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pulse fixture</title>
  <link rel="icon" href="data:,">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #fff; color: #101828; }
    header, main { max-width: 960px; margin: 0 auto; padding: 16px 20px; }
    h1 { font-size: 32px; margin: 0 0 12px; }
    .hero { display: block; width: 100%; height: auto; }
    .low { color: #c8c8c8; background: #fff; font-size: 16px; }
    .shift { background: #eef2f6; padding: 24px; margin: 12px 0; }
  </style>
  <script src="/heavy.js"></script>
</head>
<body>
  <header><h1>Pulse fixture site</h1></header>
  <main>
    <img class="hero" src="/hero.svg" width="1200" height="800" fetchpriority="low">
    <p class="low">This copy has deliberately poor contrast so axe reports a violation.</p>
    <img src="/pixel.svg" width="20" height="20">
    <p id="body-copy">Body copy used to give the page enough content for layout shift.</p>
    ${extraViolation ? '<p class="low" id="extra-contrast">A second low-contrast paragraph.</p><input type="text" id="unlabeled-input">' : ''}
    <div id="shift-target"></div>
  </main>
  <script>
    // Injected after load so it produces a measurable layout shift.
    window.addEventListener('load', function () {
      setTimeout(function () {
        var block = document.createElement('div');
        block.className = 'shift';
        block.textContent = 'Injected after load';
        document.body.insertBefore(block, document.querySelector('main'));
      }, 50);
    });
  </script>
</body>
</html>`;
}

export async function startFixture(): Promise<FixtureSite> {
  const state = { extraViolation: false, requireAuth: false };
  const hero = heroSvg();
  const pixel = pixelSvg();
  const script = heavyScript();
  const apiPadding = 'api-padding '.repeat(512);

  const routes: Record<string, { type: string; body: string }> = {
    '/heavy.js': { type: 'text/javascript; charset=utf-8', body: script },
    '/hero.svg': { type: 'image/svg+xml', body: hero },
    '/pixel.svg': { type: 'image/svg+xml', body: pixel },
  };

  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/api/private') {
      if (!isAuthorized(request)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      json(response, 200, { ok: true, padding: apiPadding });
      return;
    }

    if (pathname === '/api/echo') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        json(response, 200, {
          method: request.method,
          body,
          authenticated: isAuthorized(request),
        });
      });
      return;
    }

    if (pathname === '/api/bytes') {
      const body = 'x'.repeat(8192);
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }

    if (state.requireAuth && !isAuthorized(request)) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('unauthorized');
      return;
    }

    const route =
      pathname === '/' || pathname === '/index.html'
        ? { type: 'text/html; charset=utf-8', body: html(state.extraViolation) }
        : routes[pathname];

    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('not found');
      return;
    }

    response.writeHead(200, {
      'content-type': route.type,
      'content-length': Buffer.byteLength(route.body),
      'cache-control': 'no-store',
    });
    response.end(route.body);
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
    url: `http://127.0.0.1:${port}/`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
