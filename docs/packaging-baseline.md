# Baseline - @mtlh/pulse-audit 0.2.1

Measured 2026-11-14T16:18:49.765Z on Node 24.12.0 (win32 x64) against `@mtlh/pulse-audit@0.2.1` with Lighthouse 13.6.0.

## Package and install

| Metric                   | Value                        |
| ------------------------ | ---------------------------- |
| npm pack tarball         | 0.1 MB (69 files)            |
| Unpacked package         | 0.4 MB                       |
| Clean production install | 162.9 MB across 110 packages |
| Clean install time       | 15.94 s (warm npm cache)     |

## dist

| Metric          | Value             |
| --------------- | ----------------- |
| dist total      | 0.4 MB (66 files) |
| dist JavaScript | 0.1 MB (32 files) |
| dist sourcemaps | 0.2 MB (32 files) |

## Startup and audit

| Command                          | Median (min)    | Modules loaded                         |
| -------------------------------- | --------------- | -------------------------------------- |
| `pulse --version`                | 103 ms (93 ms)  | 10 module files (10 in node_modules)   |
| `pulse doctor --skip-network`    | 310 ms (272 ms) | not traced                             |
| `pulse audit --runs 1` (fixture) | 7.86 s          | 829 module files (897 in node_modules) |

## Largest production packages

| Package                            | On disk | Copies | Loaded by `--version` | Loaded by `audit` |
| ---------------------------------- | ------- | ------ | --------------------- | ----------------- |
| `@sentry/server-utils`             | 21.8 MB | 1      | no                    | no                |
| `sentry`                           | 20.5 MB | 1      | no                    | no                |
| `lighthouse`                       | 18.5 MB | 1      | no                    | yes               |
| `@paulirish/trace_engine`          | 15.6 MB | 1      | no                    | yes               |
| `chromium-bidi`                    | 9.0 MB  | 1      | no                    | no                |
| `@sentry/conventions`              | 8.8 MB  | 1      | no                    | no                |
| `third-party-web`                  | 7.7 MB  | 1      | no                    | yes               |
| `devtools-protocol`                | 7.2 MB  | 2      | no                    | no                |
| `@sentry/server-runtime-injection` | 6.6 MB  | 1      | no                    | no                |
| `puppeteer-core`                   | 6.0 MB  | 1      | no                    | yes               |
| `zod`                              | 5.9 MB  | 1      | no                    | yes               |
| `@sentry/core`                     | 4.9 MB  | 1      | no                    | no                |
| `axe-core`                         | 3.3 MB  | 1      | no                    | yes               |
| `lru-cache`                        | 3.2 MB  | 1      | no                    | no                |
| `oxc-parser`                       | 2.8 MB  | 1      | no                    | no                |

## Fixture audit

| Metric                    | Value   |
| ------------------------- | ------- |
| lcp                       | 2401.22 |
| cls                       | 0.07    |
| tbt                       | 0       |
| fcp                       | 1801.22 |
| ttfb                      | 0       |
| js                        | 225526  |
| css                       | 0       |
| fonts                     | 0       |
| images                    | 164654  |
| total                     | 391925  |
| requests                  | 4       |
| thirdPartyBytes           | 0       |
| thirdPartyRequests        | 0       |
| violations                | 3       |
| a11y violations           | 2       |
| Lighthouse version in LHR | 13.6.0  |
