# Handoff â€” Pulse

You are picking up `pulse-audit`, a CLI package that gates performance, accessibility and page
weight in CI. This document is the brief: what exists, what is decided, what is left, and how
to verify it.

- **Repository:** `github.com/mtlh/pulse-audit`
- **Owner:** Matthew Harvey (`github.com/mtlh`)
- **Status:** v0.2.1 live on npm as `@mtlh/pulse-audit`; trustworthy-gate, WSL, the dependency refresh and the performance pass are merged; npx-first, no composite action
- **Git:** `main` pushed; `v0.2.1` tagged and pushed by the release workflow
- **Related portfolio:** `PortfolioV2` (separate local checkout)

---

## Performance pass - Chrome reuse, concurrency, `--fast`

Measured baseline: one Lighthouse run on a trivial local page took 4.5-6.2 s; a full 3-run
audit took 17.6 s. Chrome launch + kill was about 0.67 s, and the report pipeline was already
6.5 ms, so the work was all browser lifecycle and scheduling.

Shipped:

- **Audit session.** `createAuditSession()` launches Chrome once, imports Lighthouse once and
  exposes `auditTarget(url, options)`; `auditTargets()` schedules several targets and returns
  outcomes in config order. `runAudit()` is still launch + audit + kill for library callers.
  `AuditProgressEvent` now carries `url`, so concurrent lines stay attributable.
- **One Chrome at concurrency 1.** A 4-URL fixture run with `runs: 3` went from 62.0 s
  (pre-change, four Chrome launches) to 58.7 s (one Chrome, sequential) and 30.2 s at
  `--concurrency 2`.
- **Bounded concurrency.** `--concurrency` and `config.concurrency` (default `2`, range 1-8).
  Runs for one URL stay sequential; only different URLs overlap. Report order is the config
  order, per-URL errors are isolated and a failed URL still blocks `--update-baseline`.
  Chrome permits only one tracing session per browser and Lighthouse keeps process-global
  trace-engine state, so each lane above 1 runs in a worker thread with its own Chrome. This
  was verified by a flow test with two fixture URLs.
- **Measured default.** Four URLs, `runs: 3`, medians across the URLs. Fixture: LCP 2401 ms,
  CLS 0.075, TBT 0, FCP 1801 ms, bytes 391,925, 4 requests at concurrency 1, 2 and 4. Live
  `https://mtlh.vercel.app/`: LCP 1226 -> 1229 -> 1229 ms, FCP 1002 -> 1004 -> 1010 ms,
  TTFB 20.5 -> 22.5 -> 21.0 ms, bytes 97,456 -> 97,411 -> 97,340, 8 requests; no pass/fail
  flips. Largest median drift +0.25% (LCP); TTFB moved 2 ms absolute. Wall time 64.6 -> 35.1 ->
  21.3 s. Default 2 keeps headroom for two-vCPU CI runners; 4 is opt-in.
- **`--fast`.** Opt-in local pre-check using the exact `axe-core` bundle Lighthouse depends on
  plus a CDP network profile. It only skips Lighthouse when a comparable baseline exists, the
  axe rule/node-count fingerprint matches, and every size/count budget is outside its 10%
  near-limit band and regression tolerance. Any timing, failed-request, long-task,
  third-party-main-thread or console-error budget escalates; so does a navigation error or a
  changed a11y finding. It always warns, never writes a baseline, and marks report entries with
  `method` and `enforcedBudgets`. Report schema is now v4. A flow test injects an a11y
  regression and asserts that the pre-check escalates and fails the full run.
- **`scripts/bench.mjs`.** Per-phase timings for `--url`, `--config` or `--fixture`; supports
  `--runs`, `--concurrency` and `--json`.

Verification for this pass: `npm run typecheck`, `npm test` (250 passed, 14 skipped),
`npm run test:flows` with `PULSE_E2E=1` (23 passed, 1 skipped; package flow needs
`npm run test:e2e`), and the benchmark matrix above on the same Windows box.

---

## v0.2.1 release - dependency refresh

Lighthouse 12 pulled in `@sentry/node` 9 and, through it, the deprecated
`@opentelemetry/sdk-trace-base@1.30.1`. Every Sentry 9.x resolution lands on that last 1.x
release, so neither `npm ci` nor a transitive bump could clear the warning. Lighthouse 13 uses
`@sentry/node` 11, which no longer depends on `sdk-trace-base`.

The dependency refresh itself (Lighthouse 13, Puppeteer 25, Zod 4, Commander 15, TypeScript 6,
Vitest 5, Node >= 22.19.0) was merged in PR #12, but `package.json` stayed at 0.2.0, which npm
already had, so the release workflow skipped it. This patch bumps the version so the refreshed
package can ship. There is no CLI or report-schema change; the Node floor moves to 22.19.0
because that is Lighthouse 13's minimum.

Verified with `npm run typecheck`, `npm test` (185 passed, 11 skipped), `npm run test:e2e`
(21 flow tests, including the packed install), and a live three-run dogfood audit of
`https://mtlh.vercel.app/` against `.pulse.json` budgets (LCP 1.23 s, CLS 0, TBT 0 ms,
JavaScript 1.2 KB, images 15.3 KB, 8 requests, 0 a11y violations; all budgets passed and the
LCP element resolved through the Lighthouse 13 `lcp-breakdown-insight` shape).

---

## v0.2.0 release - "trustworthy gate"

The v0.2 scope from `docs/roadmap.md` shipped as `0.2.0`: it was merged in PR #1 on top of
v0.1.0 and released by the main-branch workflow.

What changed:

- **Baseline v3**, keyed by `preset::url` for pages and `api::METHOD::url` for APIs. Version 1
  and 2 files are migrated automatically on read and rewritten as version 3 on the next
  `--update-baseline`; mobile, desktop and API baselines now coexist. `--update-baseline` is
  skipped when any target fails so a partial baseline cannot be saved.
- **Samples and variance.** Every measured run is stored in `AuditResult.samples`; the
  terminal, Markdown and HTML reports show the run spread next to the median gate.
- **Auth + API timings.** Page targets accept bearer or Basic auth with `${ENV_VAR}`
  substitution. A top-level `api` list measures authenticated HTTP endpoints with `fetch`
  (TTFB, duration, status, response bytes) and reports them in separate UI/API tables.
- **Config:** per-URL `preset`/`runs`/`auth`/`budgets` overrides, per-endpoint API settings,
  readable units (`"2.5s"`, `"250kb"`, `"10%"`), `strict`, `retries` and `timeoutMs`. Inert
  budget rules are rejected at load time.
- **Metrics:** FCP, TTFB, CSS, fonts, total weight and third-party bytes/requests; a11y impact
  buckets (`maxNewByImpact`) and `ignoreRules`.
- **Per-URL error isolation with retries.** One failed URL no longer discards the rest.
- **New CLI surface:** `pulse baseline show`, `pulse baseline prune [--dry-run]`,
  `pulse doctor [--skip-network]`, `--json`, `--quiet`, `--fail-on <error|warn|none>`,
  `--retries`, `--timeout`. `--summary` replaces its `pulse:start` block instead of appending
  duplicates. `--version` reads `package.json`.
- **Exit codes:** `2` for config/tool errors or any URL that could not be audited (successful
  URLs are still reported), `1` for check failures or warnings under `--fail-on warn`, `0`
  otherwise.

Breaking API changes: `runAudit(url, { preset, runs, retries, timeoutMs, auth })` and
`buildReport(inputs, apiInputs)`. The README has the migration summary.

Verified with `npm run typecheck`, `npm test` (169 passed, 9 Chrome/package flows skipped),
`npm run build` and `npm run test:e2e` (19 flow tests, including the packed install and the
authenticated API flows). The report JSON schema is now version 3; the HTML footer shows the
package version separately. WSL support adds Linux Chrome detection (including snap/Flatpak
fallbacks) and WSL-specific doctor guidance.

---

## 1. The product in one paragraph

`pulse audit` loads a URL in headless Chrome under a fixed mobile profile, takes the median of
N Lighthouse runs, and compares the result to a baseline from the default branch. It fails the
run only when a metric breaches its absolute budget **and** regresses beyond tolerance, or when
a new accessibility violation appears. Output is a terminal table, a JSON file, a Markdown
summary, and one self-contained HTML report. It is a plain CLI, so any CI runner can call it
with `npx @mtlh/pulse-audit`; a missing baseline is not fatal, and the exit code is non-zero on
failure.

The differentiator is the **workflow**, not the measurement: baseline deltas, adoption-friendly
a11y gating, and a report that diagnoses instead of scoring.

---

## 2. Do not relitigate these decisions

1. **Do not rebuild Lighthouse.** It already collects LCP, CLS, TBT, the trace, network
   requests and axe results. Pulse is the comparison + reporting layer. A custom CDP collector
   exists in the portfolio (`perf/cdp-trace.mjs`) but is not the engine here.
2. **Baseline deltas, not absolute scores.** Lighthouse scores are noisy on shared CI runners.
3. **Median of N, warm-up not measured.** Default N = 3. Allow 5. Warm-up defaults to a
   plain Chrome navigation; "full" keeps a discarded Lighthouse run and "none" starts cold.
4. **The report is a single HTML file.** No server, no account, no external assets. It must
   load offline and stay under ~100 KB.
5. **Ratchet semantics.** A page that is already over budget but improving does not fail.
   Enforce absolute compliance separately, later, behind `strict`.
6. **npm package name is `@mtlh/pulse-audit`; binary is `pulse`.** `pulse`, `pulse-ci` and
   `pagepulse` were taken unscoped, so the package ships under the `@mtlh` scope.
7. **Ship the CLI through npx; no composite action.** The owner explicitly chose the npx
   workflow as the distribution path. Do not add a Marketplace action unless asked again.

---

## 3. Current state

| Area                                | State                                          | Notes                                                                                                                   |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `package.json` / TS / tsup / vitest | Done                                           | Node 22.19+, ESM                                                                                                        |
| Config schema + defaults            | **Verified**                                   | zod, per-URL overrides, readable units, strict mode                                                                     |
| `init` command                      | **Verified**                                   | defaults or measured budgets via `--from`                                                                               |
| Lighthouse runner                   | **Verified (session + concurrency + retries)** | Lighthouse 13.6.0; one Chrome at concurrency 1, worker lanes above it, median of N, retries, navigate/full/none warm-up |
| API runner                          | **Verified**                                   | authenticated fetch, median of N, no warm-up; TTFB/duration/status/bytes                                                |
| LHR extraction                      | **Verified**                                   | LCP element, expanded weight metrics and axe nodes checked                                                              |
| Compare / budget logic              | **Verified (live + flows)**                    | strict mode, impact buckets, `ignoreRules`; UI and API budget evaluation                                                |
| Baseline read/write + comparability | **Verified (v3 + migration)**                  | pages keyed `preset::url`, API keyed `api::METHOD::url`; v1/v2 migrate on read                                          |
| Terminal reporter                   | Done                                           | ANSI colour, run spread, ignored-rule note, UI/API split                                                                |
| JSON reporter                       | Done                                           | report schema v3 with `apiResults`                                                                                      |
| HTML reporter                       | **Verified**                                   | self-contained, no JS; variance, third-party and cross-URL sections                                                     |
| Markdown summary                    | Done                                           | for `$GITHUB_STEP_SUMMARY`; replaces its marker block                                                                   |
| GitHub Action                       | **Dropped**                                    | owner chose npx/CLI as the delivery path                                                                                |
| WSL                                 | **Verified (unit)**                            | Linux Chrome detection incl. snap/Flatpak; `doctor` guidance                                                            |
| Unit tests                          | Done                                           | 250 unit tests; scheduler/session/fast-decision coverage                                                                |
| Integration tests / fixture site    | **Verified**                                   | deterministic fixture + 23 CLI flows incl. concurrency and `--fast`; `PULSE_E2E=1`                                      |
| Docs                                | Updated                                        | budgets, roadmap, WSL, auth/API, performance/concurrency/fast, quick start, benchmarks                                  |
| npm publish                         | **Live**                                       | `@mtlh/pulse-audit@0.2.1`; release workflow publishes new versions from `main`                                          |
| Release workflow                    | **Added**                                      | main push → publish new version → tag/release                                                                           |
| PR comment                          | Not done                                       | step summary only                                                                                                       |

`npm install` has been run and `package-lock.json` is present. `npm run typecheck`,
`npm test` (250 tests; Chrome/package flows skipped) and `npm run build` all pass.
`npm run test:e2e` runs the 23 flow tests, including fixture audits, concurrency, `--fast`,
authenticated UI/API checks and a packed install. `npm run battle-test` exercises the live
portfolio through the CLI sequence; `npm run bench` reports per-phase timings.

---

## 4. Repo map

```
pulse-audit/
├── .pulse.json                    dogfood config for mtlh.vercel.app
├── docs/
│   ├── budgets.md                 pass/fail semantics
│   └── roadmap.md                 v0.2/v0.3/v1.0 scope
├── src/
│   ├── cli.ts                     init (incl. --from) + audit/baseline/doctor
│   ├── config.ts                  schema, defaults, measured budgets, per-URL/API merge
│   ├── auth.ts                    ${ENV_VAR} expansion, bearer/basic headers
│   ├── chrome.ts                  Chrome/WSL detection and fallbacks
│   ├── doctor.ts                  environment and project checks
│   ├── runner.ts                  audit session, worker lanes, chrome-launcher + lighthouse
│   ├── audit-worker.ts            one concurrency lane (own Chrome + Lighthouse module)
│   ├── scheduler.ts               bounded, order-preserving concurrency
│   ├── fast.ts                    opt-in axe/network pre-check and escalation rules
│   ├── api.ts                     authenticated fetch timing, median pick
│   ├── extract.ts                 LHR -> AuditResult
│   ├── compare.ts                 pure budget evaluation
│   ├── report.ts                  ReportEntry assembly
│   ├── baseline.ts                read/write/comparable/merge
│   ├── format.ts                  ms/bytes/score/count formatting + HTML escape
│   ├── version.ts                 version read from package.json
│   ├── reporters/
│   │   ├── terminal.ts
│   │   ├── json.ts
│   │   ├── html.ts                renderHtml + writeHtmlReport
│   │   ├── summary.ts             Markdown for job summary
│   │   └── spread.ts              shared min/median/max spread rows
│   ├── util/                      units, median, variance, impact order
│   └── index.ts                   public API
├── scripts/
│   ├── bench.mjs                  per-phase benchmark (URL, config or fixture)
│   ├── run-e2e.mjs                builds, then runs test/flows
│   └── battle-test.mjs            live portfolio sequence
└── test/
    ├── api.test.ts               fetch timing, auth and API budget checks
    ├── auth.test.ts              env expansion and bearer/basic headers
    ├── baseline.test.ts
    ├── chrome.test.ts
    ├── compare.test.ts
    ├── config.test.ts
    ├── doctor.test.ts
    ├── extract.test.ts
    ├── format.test.ts
    ├── html.test.ts
    ├── median.test.ts
    ├── median-run.test.ts
    ├── report.test.ts
    ├── summary.test.ts
    ├── variance.test.ts
    └── flows/
        ├── fixture.ts             deterministic local site + protected API routes
        ├── helpers.ts             CLI runner, temp dirs, budgets
        ├── init.test.ts           no-Chrome init/error flows
        ├── api-only.test.ts       no-Chrome API-only config flow
        ├── api.e2e.test.ts        authenticated page + API timing flow
        ├── audit.e2e.test.ts      pass/fail outputs and --no-fail
        ├── concurrency.e2e.test.ts multi-URL overlap and report order
        ├── fast.e2e.test.ts       --fast pass, baseline refusal and a11y escalation
        ├── baseline.e2e.test.ts   baseline, deltas and new axe debt
        ├── init-from.e2e.test.ts  derive budgets from a measured page
        ├── json.e2e.test.ts       --json and --fail-on
        ├── desktop.e2e.test.ts    desktop preset
        └── package.e2e.test.ts    npm pack + install + audit
```

---

## 5. Setup and first verification

```powershell
cd <pulse-audit checkout>
npm install
npm run typecheck
npm test          # unit + no-Chrome flows; Chrome flows skip
npm run test:e2e  # fixture audits + packed install (~2 min)
npm run build
npm run battle-test  # live portfolio sequence (~3.5 min)
```

Then, against the live portfolio:

```powershell
node dist/cli.js init --from https://mtlh.vercel.app --force
node dist/cli.js audit --runs 1 --update-baseline
node dist/cli.js audit --runs 1
```

Expected on the first run:

- Chrome launches headless; no crash on Windows.
- Terminal table shows LCP / CLS / TBT / JS / Images / Requests / a11y.
- `.pulse/report.json`, `.pulse/report.html`, `.pulse/baseline.json` exist.
- The report opens offline and is under 100 KB.

**Verified at scaffold time (2026-11-02, one run, mobile):**

| Metric     | Value                          |
| ---------- | ------------------------------ |
| LCP        | 1.83 s                         |
| CLS        | 0.001                          |
| TBT        | 66 ms                          |
| JavaScript | 5.6 KB                         |
| Images     | 60.6 KB                        |
| Requests   | 42                             |
| A11y       | 11 nodes, all `color-contrast` |

The report was 14.9 KB. The LCP element resolved to
`body.antialiased > main#main-content > section.bg-cover`, which confirms the extractor's
nested-details path works. The 11 contrast nodes are a real finding worth checking against the
portfolio's claimed a11y work.

Latest dogfood run (2026-11-02, `--runs 3` + warm-up, `--update-baseline`): LCP 1.53 s,
CLS 0, TBT 0 ms, JavaScript 6.5 KB, Images 59.8 KB, 44 requests, 10 a11y nodes. All budgets
passed, exit 0, report 15.2 KB.

The run used `--runs 1`; the median path was later verified with `--runs 3` plus a discarded
warm-up. Extraction was checked against the raw LHR for LCP, CLS, TBT, JS bytes, image bytes
and request count on three runs: exact match on all six.

If Lighthouse fails, check in this order:

1. `chrome-launcher` finds Chrome (`CHROME_PATH`).
2. `lighthouse()` flags: `port`, `onlyCategories`, `formFactor`, `screenEmulation`,
   `throttling`, `throttlingMethod`.
3. The LHR audit IDs in `extract.ts` for the installed Lighthouse version. Run:
   `node -e "import('lighthouse').then(async m=>{const r=await m.default('https://example.com',{output:'json',onlyCategories:['performance','accessibility']});console.log(Object.keys(r.lhr.audits).filter(k=>k.includes('largest')||k.includes('layout')).join('\n'))})"`
   (this starts its own Chrome; use a scratch script if it is awkward).
4. The LCP element audit changed in Lighthouse 13: it now comes from
   `lcp-breakdown-insight` as a node item in the details list. The extractor also handles
   the Lighthouse 12 `largest-contentful-paint-element` shape.

---

## 6. Decisions still open (ask the human before large changes)

1. **Strict mode.** Implemented as `"strict": true` at the config root, default false.
2. **Multi-URL PR runs.** Current default audits every URL sequentially. Prefer one job per
   URL at scale.
3. **Desktop preset.** Implemented in the runner and keyed separately in baseline v3.
4. **History storage.** v0 uses a workflow artifact. A trend chart needs durable storage
   (`gh-pages` or a small JSON in a `pulse-history` branch). Do not add a database.
5. **PR comment.** The step summary is enough for v0. Add Octokit + a hidden marker when
   asked.

---

## 7. Build order and acceptance criteria

Work top to bottom. Each step should leave `npm run typecheck && npm test` green.

### Step 1 â€” Make the Lighthouse path real

- ~~Run one live audit.~~
- Run a second audit and confirm the median path (use `--runs 3`).
- Fix any type errors and flag shape issues.
- Confirm `extractResult` returns sensible numbers (compare against the Lighthouse JSON:
  LCP, CLS, TBT, JS bytes, request count).
- **Acceptance:** two consecutive `--runs 1` audits of the same URL produce a report without
  throwing, and LCP is within ~20% of the Lighthouse JSON value. _(Confirmed 2026-11-02:
  1.53 s and 1.53 s; runs=3 and the warm-up path also verified)_

### Step 2 â€” Verify the HTML report

- Open `.pulse/report.html` in Chrome at 390 px and 1280 px.
- Check: no horizontal scroll, status pills correct, requests bars proportional, long URLs
  ellipsized, axe selectors escaped.
- **Acceptance:** report < 100 KB, no console errors, readable at 390 px. _(Verified
  2026-11-02: 14.9 KB, zero console errors, no horizontal scroll at 390 or 1280 px. A long
  selector previously forced 602 px of scroll; fixed with `minmax(0, 1fr)` and wrapping.
  Escaping is covered by `test/html.test.ts`.)_

### Step 3 â€” Baseline flow

- `audit --update-baseline`, then edit a budget to force a failure, then `audit`.
- Confirm exit code 1 and a readable delta.
- Confirm a baseline with a different `runs` value is ignored with a warning.
- **Acceptance:** pass/fail/exit-code matrix in `docs/budgets.md` is true. _(Verified
  2026-11-02 with a temporary config: first `--update-baseline` exits 0, the next run reports
  deltas and exits 0, a lowered baseline exits 1 with `â†³ regressed +38.7% vs baseline`, an
  over-max-but-improving metric exits 0 with `â†³ over max â€¦ but not a regression`, and a
  different `--runs` count warns and ignores the baseline. Failures, warnings and ratchet
  passes now print their reason in the terminal, HTML and Markdown reports.)_

### Step 4 â€” Fixture site + integration tests

Create `test/fixtures/site/` with:

- a large hero image that is _not_ preloaded (late LCP),
- an element injected after load that shifts layout (CLS),
- an `<img>` without `alt` and a low-contrast paragraph (axe),
- a ~200 KB script (weight budget).

Serve it from a tiny Node server in the test. Run one audit and assert the report JSON.
Keep the fixture deterministic: no external requests, fixed dimensions.

- **Acceptance:** `npm test` covers extraction, compare and an end-to-end audit behind
  `PULSE_E2E=1` so CI without Chrome can skip it. _(Verified 2026-11-02. The fixture lives in
  `test/flows/fixture.ts` and generates the heavy assets in memory. Measured: LCP 2.40 s on
  `img.hero`, CLS 0.075, JS 220 KB, images 161 KB, 4 requests, 3 axe nodes. `test/flows/`
  covers init, pass/fail/`--no-fail`, baseline seeding, deltas, run-count mismatch, new axe
  debt, `init --from`, desktop and a packed install. 16 flow tests pass with
  `npm run test:e2e`; 5 no-Chrome flow tests run in `npm test`.)_

### Step 5 â€” Flakiness

- Run the same URL 10 times on CI and record variance per metric.
- Add a note to the docs for metrics that exceed 10% variance.
- Consider `runs: 5` guidance for GitHub-hosted runners.
- **Acceptance:** zero false failures across 20 consecutive runs of an unchanged page.
- **Local observations (2026-11-02):** live portfolio LCP stayed in 1.51â€“1.66 s across runs
  (about 5% spread); TBT ranged 0â€“133 ms but is already `warn`; requests, JS, images and a11y
  node count were stable. The fixture produced the expected pass/fail outcome throughout the
  15 flow tests (~20 Lighthouse runs). No unexpected pass/fail flips were observed. A real
  GitHub-hosted runner sample is still needed for the 20-run acceptance.

### Step 6 â€” GitHub Action (dropped)

The owner chose `npx @mtlh/pulse-audit` as the only delivery path. Do not ship a composite action or
Marketplace release. The old action file and its contract test were removed. CI for this repo
still runs `npm run test:e2e`; consumers call the CLI from their own runner.

### Step 7 â€” Docs and packaging

- README GIF: failing audit â†’ failing PR â†’ report.
- `npm pack --dry-run`; confirm only `dist`, `README.md` and `LICENSE` ship.
- Add `repository`, `homepage`, `bugs`, `keywords` to `package.json`.
- `npm publish --access public` (done; `0.1.0` live after npm staged-release approval).
- Tag `v0.1.0`; Marketplace release for the action.
- **Acceptance:** `npx @mtlh/pulse-audit@0.1.0 --version` works on a clean machine.

### Step 8 â€” Dogfood

- Add a PortfolioV2 CI step that runs `npx @mtlh/pulse-audit audit`.
- Baseline `main`, then open a throwaway PR that adds a large image.
- Record the before/after numbers for the portfolio case study.
- **Acceptance:** the portfolio PR fails for the right reason, and the report explains why.

---

## 8. Technical notes and traps

### Lighthouse

- Lighthouse 12 is ESM. `import lighthouse from 'lighthouse'` and `import * as chromeLauncher
from 'chrome-launcher'`.
- `lighthouse()` returns `RunnerResult | undefined`; guard it.
- Use one Chrome instance for all runs, then `chrome.kill()` in `finally`.
- `onlyCategories: ['performance', 'accessibility']` keeps runs faster; do not enable SEO/best
  practices.
- The `network-requests` audit items expose `transferSize` (compressed, what users download)
  and `resourceSize` (uncompressed). Budgets use `transferSize`.
- `throttlingMethod: 'simulate'` is the stable CI choice. Do not use `devtools` throttling for
  baselines.
- LCP element comes from `audits['lcp-breakdown-insight'].details.items` (the node item) in
  Lighthouse 13. The Lighthouse 12 `largest-contentful-paint-element` shapes (nested and
  flat) are still handled.
- Axe results are already in the accessibility category. `scoreDisplayMode` values to ignore:
  `notApplicable`, `manual`, `informative`. Count `score < 1` audits as violations.

### Comparison

- `regression` is a percentage. A metric fails on regression only if `max` is also breached
  **or** there is no baseline. See `docs/budgets.md`.
- `tbt` defaults to `warn` because CI variance is high.
- A11y delta is keyed `${ruleId}::${selector}`. Two identical selectors in different contexts
  collapse; add `failureSummary` as a third key if that becomes a real false negative.
- `maxNew` is only gated when a comparable baseline exists. Before that, existing violations
  count against `maxViolations` but not against `maxNew`, so establishing a baseline does not
  fail on inherited debt. A present-but-incomparable baseline behaves like no baseline.

### Baseline

- Store `preset`, `runs`, `lighthouseVersion` in every result.
- `comparableBaseline()` returns null on mismatch. Never compare across Lighthouse majors.
- Baseline file: `{ version: 3, results: { [preset::url]: AuditResult }, apiResults: { [api::METHOD::url]: ApiResult } }`.
  v1 and v2 files migrate on read. UI and API baselines are keyed separately.
- Do not commit `.pulse/`; it is gitignored.

### Distribution

- The package is published as `@mtlh/pulse-audit`; the binary is `pulse`. Consumers should run
  `npx @mtlh/pulse-audit@0.2.1 ...`.
- `.github/workflows/release.yml` publishes from `main` only when `package.json` has a version
  not already on npm, waits for registry propagation, then tags and creates a GitHub release.
  It requires the `NPM_TOKEN` repository secret (or trusted publishing configured on npm).
  If npm stages the version, approve it on npmjs.com and re-run the workflow.
- No composite action ships. Keep it that way unless the owner asks for one again.
- A missing baseline is not fatal: the first run records inherited debt and `--update-baseline`
  seeds it. Pull-request runs compare against the saved file.
- `--github-output` writes `report-path` and `failed` to `$GITHUB_OUTPUT`, which works in any
  GitHub Actions job without a custom action.

### Testing

- `npm test` builds, then runs unit tests and no-Chrome flows. Chrome/package files are skipped
  by `describe.skipIf`.
- `npm run test:e2e` sets `PULSE_E2E=1` and `PULSE_PACKAGE=1`, builds, and runs `test/flows`
  through `vitest.flows.config.ts`. Flow files are split by scenario and run in up to four
  parallel workers, so a slow audit does not block the rest of the suite.
- `test/flows/fixture.ts` serves a deterministic page entirely from memory. Missing alt text,
  low contrast, a 160 KB SVG hero and a 220 KB script give stable LCP, CLS, weight and axe
  signals with no external requests.
- Lighthouse full-page screenshots are disabled (`disableFullPageScreenshot`) because Pulse never
  reads them. That saves about a second per run and leaves metrics and axe results unchanged.
- Warm-up defaults to `navigate`: one plain Chrome page load via `puppeteer-core`, which warms
  DNS, TLS, the server and the JS compiler without a Lighthouse trace or axe pass. Use a full
  warm-up to restore the discarded Lighthouse run, or none to measure a cold browser. The
  navigation warm-up is capped at 10 s so a stalled third-party request cannot delay the
  measured runs.
- `timeoutMs` defaults to Lighthouse's own 45 s `maxWaitForLoad` (not 120 s). Every retry adds
  another full timeout, so a stalled page used to turn a three-run audit into a ten-minute job.
  The audit prints one progress line per warm-up and measured run, including its duration, so
  CI logs show where the time goes.
- Lighthouse and `puppeteer-core` are imported lazily inside `runAudit`, and the import runs in
  parallel with the Chrome launch. Non-audit commands (`doctor`, `baseline`, `--version`) and
  library imports therefore start in about 100 ms instead of 1.7 s.
- `npm run battle-test` runs `init --from`, baseline update/compare and a forced regression
  against `https://mtlh.vercel.app/`. It writes `.pulse/battle-test.md`.
- Flow tests invoke the built `dist/cli.js` in a temp working directory, so they exercise the
  same path as an installed user. `test/flows/package.e2e.test.ts` additionally runs
  `npm pack`, installs the tarball, and audits through the installed package.

### Windows

- `chrome-launcher` usually finds Chrome. If not, set `CHROME_PATH` to
  `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- The CLI writes `.pulse/` relative to the current directory.

### WSL

- WSL needs a **Linux** Chrome/Chromium inside the distro. A Windows `chrome.exe` is not a
  reliable Lighthouse target because its DevTools port lives on the Windows side.
- `src/chrome.ts` detects WSL, checks `CHROME_PATH`, `chrome-launcher` installs, and
  Linux/snap/Flatpak fallbacks (`/usr/bin/google-chrome`, `/snap/bin/chromium`, etc.).
- `pulse doctor` reports the detected binary and warns when `CHROME_PATH` points at `.exe`.
- Chrome is launched with `--no-sandbox` and `--disable-dev-shm-usage`, which WSL needs.

### Report

- Inline everything. No CDN, no fonts, no chart library.
- Escape every value that came from the audited page (URLs, selectors, snippets). `escapeHtml`
  in `format.ts`.
- The report should pass its own budget: < 100 KB, no layout shift, system fonts.

### Naming

- The public package is `@mtlh/pulse-audit` (the unscoped `pulse-audit` was not used).
- Binary name `pulse` is fine within the package, but a global install can collide with other
  tools. Document `npx @mtlh/pulse-audit` as the primary invocation.

---

## 9. Dogfood data from the portfolio

Measured with `PortfolioV2/perf/cdp-trace.mjs` on 2026-11-02: mobile, 4x CPU throttle, 3G.

| Metric                 | Value                              | Note                                      |
| ---------------------- | ---------------------------------- | ----------------------------------------- |
| LCP                    | 1.33 s                             | hero CSS background image; late discovery |
| CLS                    | 0.0012                             | already excellent                         |
| Long task              | 190 ms at 1.68 s                   | one main-thread block remains             |
| Requests               | 81                                 | ~27 individual skill-icon SVGs            |
| Third party            | `ghchart.rshah.org` at 752 ms TTFB | on the critical path                      |
| HTML / CSS / router JS | 15.5 KB / 19.3 KB / 5.6 KB         | base is lean                              |

Use these as the starting point for `.pulse.json` (already seeded) and the case study. Likely
fixes: `<img fetchpriority="high">` + preload for the hero, sprite/inline the skill icons,
self-host the GitHub chart, then re-baseline and tighten `requests` from 90 to ~55.

---

## 10. Definition of done for the scaffold â†’ v0.1

- [x] `npm install && npm run typecheck && npm test && npm run build` all pass.
- [x] A live audit of `https://mtlh.vercel.app/` produces a report (runs=1).
- [x] A 3-run audit exercises the median path.
- [x] The fixture site proves a pass and a fail with the expected exit code.
- [x] HTML report works offline at 390 px and 1280 px, under 100 KB.
- [ ] No false failures across 20 identical CI runs.
- [x] No composite action; npx is the delivery path.
- [ ] README has a working quick start and a GIF.
- [x] `npm pack` is clean (dist, README, LICENSE only); published on npm; tagged `v0.1.0`.
- [ ] PortfolioV2 runs the action and has before/after numbers.

---

## 11. Copy-paste brief for the next agent

> You are continuing `pulse-audit` at its repository checkout. Read
> `HANDOFF.md` first. Steps 1-4 are complete and v0.1.0 is live on npm. The delivery path is
> `npx @mtlh/pulse-audit`; there is no composite action. `npm run test:e2e` runs the 16 flow tests
> (including a packed install) and `npm run battle-test` exercises the live portfolio. Your next
> jobs are Step 5 (flakiness/variance) and Step 7 (README GIF, tag maintenance). Use
> `pulse init --from <url>` as the primary adoption path: it measures the page and writes
> minimums with headroom. Keep `npm run typecheck`, `npm test` and `npm run test:e2e` green.
> Report exact commands run and any new budget defaults.
>
> The package's purpose is to be the one central place where a team defines minimum performance,
> weight and accessibility, and one command that verifies them. Prefer changes that make the
> config clearer and the pass/fail reason more obvious over new measurement features.

---

## 12. Useful commands

```powershell
npm install
npm run typecheck
npm test
npm run test:e2e
npm run battle-test
npm run build
node dist/cli.js --help
node dist/cli.js init --from https://mtlh.vercel.app --force
node dist/cli.js audit --runs 1 --update-baseline
node dist/cli.js audit --runs 3
npm pack --dry-run
npx @mtlh/pulse-audit@0.1.0 --version
```

Reference trace tooling in the portfolio:

```powershell
cd <PortfolioV2 checkout>
node perf/cdp-trace.mjs
node perf/analyze-mainthread.mjs
```
