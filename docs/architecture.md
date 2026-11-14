# Architecture

Pulse is a pipeline of small, single-purpose modules. The shared components below exist so
the same concept is spelled once and every stage reads it from the same place. When adding a
feature, extend these modules instead of open-coding a second copy.

```
config → runner / api → extract / fast → compare → report → reporters
                 \________ metrics registry ________/
```

## 1. The metric registry (`src/metrics.ts`)

`AUDIT_METRICS` and `API_METRICS` are the single source of truth for every measured value:

| Field             | Used by                                                     |
| ----------------- | ----------------------------------------------------------- |
| `key`             | `AuditMetrics`, `BudgetSet`, config schema, comparison loop |
| `label`           | terminal, Markdown, HTML, `init` summary, docs              |
| `format`          | value, delta and budget formatting in every reporter        |
| `defaultSeverity` | `compare.ts` when a budget rule does not set `severity`     |
| `parse`           | config validation (`"2.5s"`, `"250kb"`, `"10%"` and so on)  |
| `fast`            | `--fast` decides between the network-size and timing lanes  |

Everything else derives from the registry:

- `config.ts` builds the page and API budget schemas from it.
- `compare.ts` iterates it to produce checks.
- `util/variance.ts` derives `AUDIT_METRIC_KEYS`.
- `fast.ts` derives `FAST_SIZE_METRICS` and `FAST_TIMING_METRICS`.
- `cli.ts` renders the `init --from` table from it.
- `auditMetrics()` creates a complete zeroed metric set, so a new metric is picked up by
  extraction, the runner median and the fast path without editing three literals.

**Adding a metric:** add it to `types.ts` (`AuditMetrics` and, if budgetable, `BudgetSet`),
add one definition to `AUDIT_METRICS`, and fill the value in `extract.ts` (or the fast
measurement). The budget schema, labels, formatting, variance and reporters need no change.

## 2. The check view (`src/checks.ts`)

A `Check` is the domain result of comparing one metric to its budget and baseline. It is not
a display model. `checkView(check)` adds exactly the strings every reporter needs:

- `value`, `budget`, `deltaText`, `deltaPctText` and `deltaSummary`
- `hasDelta` / `hasBaseline` for the HTML empty states
- `statusLabel` for plain text
- `note` for the explanations worth showing

`checkNotes`, `countChecks` and `findCheck` live next to it. The terminal, Markdown and HTML
reporters own their markup and colour, but never recompute a number or a label. Feed a new
reporter from these helpers rather than from raw `Check` fields.

`reporters/spread.ts` follows the same rule for run variance: `spreadRows` decides which
metrics varied and `spreadText` renders the compact fragment, so all three reporters agree.

## 3. Shared runtime utilities

| Module             | Owns                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `util/errors.ts`   | `errorMessage` and `isEnoent` for every catch site                  |
| `util/files.ts`    | text/JSON read and write, parent directories, trailing newline      |
| `util/guards.ts`   | `isRecord` for untrusted JSON                                       |
| `util/requests.ts` | `sameOrigin` and `sumRequestBytes` for Lighthouse and the fast path |
| `util/a11y.ts`     | impact ordering and `isA11yImpact`                                  |
| `util/text.ts`     | ANSI-aware `padRight` and `truncate` for terminal tables            |
| `util/units.ts`    | human-readable unit parsers consumed by the registry                |

Config, baseline, JSON, HTML and Markdown writers all use `util/files.ts`. That is what keeps
the missing-parent-directory behaviour, UTF-8 encoding and trailing newline identical across
every file Pulse creates.

## 4. Reporters are renderers

`reporters/terminal.ts`, `summary.ts` and `html.ts` may differ in markup, escaping and
colour, but they share:

- `checkView` / `checkNotes` / `countChecks` from `checks.ts`
- `spreadRows` / `spreadText` from `reporters/spread.ts`
- `formatValue`, `formatDelta`, `formatPercent`, `formatRange`, `escapeHtml` from `format.ts`
- `writeJsonFile` / `writeTextFile` from `util/files.ts`

No reporter reads `BudgetRule` directly, recomputes a delta, or counts statuses by hand.

## 5. Pipeline boundaries

- `config.ts` validates and resolves; it owns defaults and merges.
- `runner.ts` / `api.ts` measure; they return `AuditResult` / `ApiResult` with `samples`.
- `extract.ts` maps Lighthouse's LHR into the registry's metrics.
- `fast.ts` decides whether the cheap pre-check is trustworthy; it escalates by default.
- `compare.ts` only evaluates budgets and accessibility debt.
- `report.ts` assembles entries, filters ignored rules once, and aggregates counts.
- `reporters/*` render; they never mutate the report.

Keep new modules on one side of those boundaries. A reporter that needs a comparison value
should receive it through `Check`; a runner that needs a metric label should not import the
reporters.

## 6. Verification

```bash
npm run typecheck
npx vitest run          # unit tests
npm run build
npm run test:flows      # CLI flows (PULSE_E2E=1 for fixture audits)
```

`test/metrics.test.ts` and `test/checks.test.ts` guard the registry and view contracts. If you
add a metric, the registry test fails until the new definition is present.
