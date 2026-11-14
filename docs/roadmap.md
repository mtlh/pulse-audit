# Feature expansion plan

Status: v0.2.0 ("trustworthy gate") is released on npm, followed by the v0.2.1 dependency
refresh. v0.3 and v1.0 remain pending. This
document answers three questions: what Pulse does well today, what it is missing, and which
gaps are worth closing in which order.

Pulse's advantage is the **workflow**, not the measurement. Every item below is judged by
whether it makes the pass/fail decision more trustworthy, the config clearer, or the failure
easier to diagnose. Anything that turns Pulse into a Lighthouse replacement or a hosted
dashboard is out of scope by design.

---

## 1. Where Pulse stands

Strong today:

- One config file, one command, one exit code.
- Median of N runs with a discarded warm-up.
- Baseline deltas plus a ratchet, so inherited debt does not block adoption.
- New-only accessibility gating.
- Self-contained HTML report that names the LCP element, heaviest requests and axe nodes.
- Deterministic fixture + CLI flows + packed-install test.

The gaps below are mostly **trust**, **coverage** and **workflow**. The measurement layer is
fine; the decision layer needs to get harder to fool.

---

## 2. Gap analysis

> This section is a snapshot taken before v0.2 shipped, kept to show why the work was
> prioritised. Many of the gaps below are now closed; section 3 is the current status.
> Line references point at the pre-v0.2 tree and may have drifted.

### 2.1 Correctness and trust

| #   | Gap                                                                                                                                                                     | Why it matters                                                                                                                               | Priority | Effort |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 1   | **Baseline is keyed by URL only** (`baseline.ts:46`). Mobile and desktop share one slot.                                                                                | Auditing both presets overwrites one baseline; the comparability check then rejects the other and prints a warning. Silent loss of the gate. | P0       | S      |
| 2   | **Per-run samples are discarded** (`runner.ts:35-56`). Only the median is stored.                                                                                       | CI flakiness is invisible. The 20-run no-false-failure acceptance in `HANDOFF.md` cannot be demonstrated from a report.                      | P0       | M      |
| 3   | **One failed Lighthouse run aborts the whole audit** (`runner.ts:67-86`).                                                                                               | A transient Chrome/network failure fails every URL in the config. No retry, no partial results.                                              | P0       | S      |
| 4   | **`pickMedianRun` takes a11y from the LCP-median run only.**                                                                                                            | Violations can appear/disappear between runs. A real new violation can be missed if the chosen run happened not to catch it.                 | P0       | S      |
| 5   | **`init --from` measures one run** (`cli.ts:78`) while the default config audits three.                                                                                 | Derived budgets come from the noisiest sample, making them too loose or too tight depending on luck.                                         | P1       | S      |
| 6   | **Version is duplicated** (`cli.ts:23` vs `package.json`).                                                                                                              | `--version` can drift from the published package.                                                                                            | P1       | XS     |
| 7   | **Inert rules are accepted silently.** A budget with neither `max` nor `regression` is ignored (`compare.ts:54`); `a11y.max`/`a11y.regression` are accepted but unused. | A typo or a copy-pasted rule looks configured but does nothing.                                                                              | P1       | S      |
| 8   | **Lighthouse patch releases invalidate the whole baseline** (`baseline.ts:40-42`).                                                                                      | A routine dependency update silently disables comparisons.                                                                                   | P1       | S      |
| 9   | **No retry/timeout policy or partial-success exit code.**                                                                                                               | Tool failures and budget failures share the same blast radius.                                                                               | P1       | S      |

### 2.2 Coverage

| #   | Gap                                                                                                                           | Why it matters                                                                                                               | Priority | Effort |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 10  | **Per-URL budgets do not exist.** `budgets` is global (`config.ts:24-34`).                                                    | A homepage and an authenticated dashboard cannot share ceilings. Multi-URL support is currently cosmetic.                    | P0       | M      |
| 11  | **Only six metrics + a11y nodes.** No FCP, TTFB, CSS, fonts, total bytes, third-party bytes/requests, DOM size or long tasks. | Page weight and third parties are usually the real regression. CSS and fonts are completely invisible.                       | P1       | M      |
| 12  | **A11y impact is flattened** (`extract.ts:81-83`) and all nodes count equally.                                                | One critical violation is treated like ten minor ones. There is no way to gate critical/serious only, and no rule allowlist. | P1       | M      |
| 13  | **A11y keys are `rule::selector`** (`compare.ts:31-43`).                                                                      | Selector churn creates "new" violations on unchanged debt, which teaches people to ignore the gate.                          | P1       | M      |
| 14  | **No auth, headers, cookies or custom Lighthouse config.**                                                                    | Staging and authenticated apps cannot be audited at all. This is the most common adoption blocker for teams.                 | P1       | M      |
| 15  | **No local dev-server integration.**                                                                                          | Local use requires a separately running server and a URL. `pulse audit http://localhost:3000` is the only option.            | P2       | M      |
| 16  | **No crawl/sitemap/route discovery.**                                                                                         | Auditing 30 routes means 30 config entries. Useful, but not the differentiator.                                              | P2       | L      |
| 17  | **One preset per run.**                                                                                                       | Mobile and desktop need separate invocations and, today, separate baseline files.                                            | P2       | M      |

### 2.3 CI and workflow

| #   | Gap                                                                                         | Why it matters                                                                                                                                | Priority | Effort |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 18  | **No PR comment, annotations or SARIF.**                                                    | Step summary + artifact is enough for a solo repo, not for a team that lives in the PR. a11y findings could go to GitHub code scanning today. | P1       | M      |
| 19  | **Baseline is a local artifact with no fetch/publish helper.**                              | The most common setup error is a PR job that cannot see `main`'s baseline, so the ratchet silently degrades to absolute budgets.              | P1       | S      |
| 20  | **No baseline management.** No `pulse baseline show/prune/diff`; removed URLs stay forever. | Stale baselines accumulate and hide config drift.                                                                                             | P1       | S      |
| 21  | **No `--json` stdout, `--quiet` or `--fail-on warn`.**                                      | Integration with scripts and other tools requires reading files. Warnings cannot fail a build.                                                | P1       | S      |
| 22  | **No `pulse doctor`.**                                                                      | Chrome missing, config invalid, baseline incompatible and URL unreachable all surface as different errors after a long run.                   | P1       | S      |
| 23  | **Multi-URL runs are sequential and launch Chrome per URL** (`cli.ts:184-191`).             | CI time scales linearly with route count.                                                                                                     | P2       | M      |
| 24  | **`--summary` appends without a marker.**                                                   | Re-running a job duplicates the summary section.                                                                                              | P2       | XS     |
| 25  | **No changed-route detection.**                                                             | A PR that touches one page still audits the whole config.                                                                                     | P2       | M      |

### 2.4 Reporting and DX

| #   | Gap                                                                                                                                   | Why it matters                                                                                               | Priority | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| 26  | **No cross-URL summary or navigation.** The HTML report is an aggregate chip row followed by sequential sections (`html.ts:151-155`). | With more than ~4 URLs the report stops being skimmable.                                                     | P1       | M      |
| 27  | **No variance display.** Only the median is shown.                                                                                    | Users cannot tell a real regression from noise, which is the core promise.                                   | P0       | S      |
| 28  | **No "fix this first" ranking.**                                                                                                      | The report lists findings but does not prioritise the request/element/rule with the biggest payoff.          | P1       | S      |
| 29  | **No third-party section.** Third-party data is extracted (`types.ts:54`) but only shown as a tag.                                    | Third-party weight/TTFB is a common regression source and is currently buried.                               | P1       | S      |
| 30  | **No history or trend.**                                                                                                              | One report shows one moment. A gate is more trusted when it shows direction. Requires a storage decision.    | P2       | M      |
| 31  | **JSON has no published schema or version contract.**                                                                                 | Consumers must reverse-engineer the shape; changes break them silently.                                      | P1       | S      |
| 32  | **Config has no `$schema` and units are raw numbers** (`js: 250000`).                                                                 | "Clarify the config" is an explicit product goal; `"250kb"` and `"2.5s"` are unambiguous, raw bytes are not. | P1       | S      |
| 33  | **No examples directory, comparison doc or migration guide.**                                                                         | New users cannot map their current LHCI/pa11y setup onto Pulse.                                              | P2       | M      |

---

## 3. Roadmap

### v0.2 - "Trustworthy gate" - implemented in this 0.1.0 tree

Goal: no lost baselines, no flaky failures, no invisible noise. This release was mostly
correctness work; it made the existing promise true before widening scope.

1. **[x] Baseline v3 keyed by `preset::url`** (plus `api::METHOD::url` for APIs) with a v1/v2
   migration path.
   `pulse baseline show` and `pulse baseline prune` ship. An incompatible run cannot overwrite
   a comparable baseline; `--update-baseline` is skipped when any URL fails.
2. **[x] Samples and variance.** Every measured run is stored in `AuditResult.samples`; the
   terminal, Markdown and HTML reports show min/median/max spread next to the median gate.
3. **[x] Retry policy.** `--retries <n>` (default 1), `--timeout <ms>`, and per-URL error
   isolation. A failed URL no longer discards the others: successful URLs are reported, then
   the command exits 2.
4. **[x] Per-URL budgets.** URL entries accept `preset`, `runs` and `budgets`; page rules
   deep-merge over the global block.
5. **[x] `strict` mode.** `"strict": true` makes an absolute `max` breach fail even when the
   page is improving. Warnings stay warnings.
6. **[x] Config hardening + readable units.** `"2.5s"`, `"250kb"` and `"90"` are accepted;
   rules that set neither `max` nor `regression`, and a11y rules with no gate, are rejected.
   The standalone JSON Schema file remains deferred because this release explicitly excludes it;
   validation is enforced by the config loader.
7. **[x] Single version source.** `pulse --version` reads `package.json` at runtime.

Acceptance:

- [x] Mobile and desktop baselines coexist; running one never destroys the other.
- [x] A report shows min/median/max for every checked metric that has samples; the spread is
      visible next to the median.
- [x] Killing one Lighthouse run does not discard the other URLs.
- [x] A config with an inert rule fails validation with the exact rule path.
- [x] `pulse init --from` derives budgets from the configured run count, not one sample.

### v0.3 — "Fit real sites"

Goal: audit the pages teams actually ship, behind the auth they actually use, and make the
failure land in the PR.

1. **[x] More budgets:** `fcp`, `ttfb`, `css`, `fonts`, `total`, `thirdPartyBytes`,
   `thirdPartyRequests` and `longTasks` shipped. Keep TBT; do **not** promise
   INP from lab data (INP is field-only, so it is a documented non-goal).
2. **[x] A11y impact gating.** Per-node impact and `maxNewByImpact` buckets shipped in
   this tree, and the violation key includes `failureSummary` with a v1-baseline fallback.
   A rule allowlist (`ignoreRules`) shipped; per-rule expiry remains.
3. **[~] Reachability:** bearer/Basic page auth with `${ENV_VAR}` substitution and an `api`
   list for authenticated timing checks shipped in this tree. `auth.cookies` and a
   `lighthouse` block for `configPath`, flags and category opt-in remain. Secrets stay in CI
   env.
4. **[ ] CI surfaces:** opt-in `--pr-comment` (hidden marker, update in place, GitHub REST via
   `fetch`, no Octokit dependency), `--sarif <path>` for accessibility, and GitHub
   `::error`/`::warning` annotations for failed checks.
5. **[ ] Baseline helpers:** `pulse baseline pull/push` for artifact or branch storage, so the
   PR job cannot silently run without `main`'s baseline.
6. **[~] CLI ergonomics:** `--json`, `--quiet`, `--fail-on warn` and `pulse doctor` shipped in
   this tree. `--start "<cmd>"` + `--wait-for <url>` for local dev servers remains.
7. **[~] Reporting:** the cross-URL summary table and third-party section shipped in this tree.
   A "fix first" list ranked by bytes, LCP element and top axe rule remains.

Acceptance:

- [x] An authenticated staging page can be audited with a token or Basic credentials from
      env, with secrets absent from the report, and API endpoints get their own timing table
      (this tree). Additional custom headers/cookies remain.
- [ ] A PR comment updates in place across pushes and links the HTML artifact.
- [x] A rule allowlist suppresses only the named rule and the suppression is visible in the
      report (this tree).
- [x] `pulse doctor` explains every common failure in one screen (this tree).

### v1.0 — "Signal over time"

Goal: make the gate legible across runs without becoming a service.

1. **History file + trend.** Append compact results to `.pulse/history.json` (or a
   `pulse-history` branch through the baseline helpers). Render a sparkline and a
   "last 10 runs" table. No database, per the existing decision.
2. **Multi-preset runs.** `--preset mobile,desktop` with separate baselines; the HTML report
   gets tabs or sections per preset.
3. **Baseline diffing.** `pulse baseline diff <a> <b>` and `pulse compare <report-a> <report-b>`
   for offline review.
4. **Release hygiene:** changesets, a changelog, a docs page with an examples directory, and
   a comparison page against LHCI/pa11y-ci/Unlighthouse.
5. **Optional route discovery:** sitemap-based sampling with an explicit `--limit`, never a
   full crawl by default.

Acceptance:

- Ten consecutive `main` runs render a trend with no manual data wrangling.
- A desktop and a mobile baseline can be updated independently in one command.
- Two saved reports can be diffed without Chrome.

---

## 4. What to do first

The first sprint shipped in this 0.1.0 tree:

1. [x] Baseline `preset|url` keying + migration.
2. [x] Samples/variance in the result and report.
3. [x] Per-URL budgets.
4. [x] Retry + per-URL error isolation.
5. [x] `strict` mode + config validation.
6. [x] Readable units + single version source. The standalone JSON Schema file is still
       deferred.

Next sprint candidates, in order:

1. Auth headers/cookies and a custom Lighthouse config block (highest adoption blocker).
2. Baseline `pull/push` helpers for CI.
3. PR comment + SARIF + GitHub annotations.
4. `--start`/`--wait-for` local dev-server support and a "fix first" ranking in the report.

---

## 5. Deliberate non-goals

- **Do not rebuild Lighthouse.** No custom trace collector as the primary engine.
- **No hosted dashboard, account or database.** History is a file or a branch.
- **No composite GitHub Action.** npx remains the delivery path.
- **No SEO category, and no best-practices scores.** The `best-practices` category is audited
  only for `errors-in-console`; its score is never reported or gated.
- **No field-data/INP promises.** Pulse is a lab gate; say so in the docs.
- **No crawl-all-by-default.** Route discovery must be bounded and explicit.

---

## 6. Decisions needed

These change the shape of the roadmap, so they should be answered before v0.3 work starts:

1. **Who is the next user: a solo developer or a team?** PR comments, SARIF and baseline
   pulling are only worth it for teams; variance and `doctor` help everyone.
2. **Where does the baseline live?** A committed file, a CI artifact, or a `pulse-history`
   branch? This determines whether `pulse baseline pull/push` is in v0.3 or v1.0.
3. **Is multi-preset a first-class requirement or two configs?** If teams need both in one
   run, per-preset baselines move to v0.2 rather than v1.0.
4. **Should accessibility fail on all impacts or only serious/critical?** This is a product
   stance, not an implementation detail; it changes the default config.
5. **Is authenticated/staging auditing a target use case?** If yes, item 14 is the highest
   adoption item in the plan and should move into v0.2.
