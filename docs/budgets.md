# Budgets

Pulse compares every audit to three things:

1. **The absolute ceiling** (`max`).
2. **The baseline** captured on the same preset, run count and Lighthouse major.
3. **The tolerable change** (`regression`, a percentage).

Every metric rule needs at least one of `max` or `regression`. A rule with neither is
rejected when the config loads, so a typo cannot silently disable a gate.

## Units

Budgets are stored in normalized numbers, but the config accepts readable values:

| Kind        | Accepted                                 | Examples                   |
| ----------- | ---------------------------------------- | -------------------------- |
| Duration    | ms number, `"2500ms"`, `"2.5s"`, `"1m"`  | `"2.5s"` becomes `2500`    |
| Bytes       | number, `"250000"`, `"250kb"`, `"1.5mb"` | `"250kb"` becomes `256000` |
| Regression  | number or `"10%"`                        | `"10%"` becomes `10`       |
| CLS / count | number or numeric string                 | `0.05`, `90`, `"90"`       |

`kb`/`kib` and `mb`/`mib` both use powers of 1024. `pulse init` serializes normalized numbers
so the config stays valid JSON for editors and review.

## Metrics and defaults

| Key                  | Measures                       | Default severity in generated config |
| -------------------- | ------------------------------ | ------------------------------------ |
| `lcp`                | Largest Contentful Paint, ms   | error                                |
| `cls`                | Cumulative Layout Shift, score | error                                |
| `tbt`                | Total Blocking Time, ms        | warn                                 |
| `fcp`                | First Contentful Paint, ms     | error                                |
| `ttfb`               | Server response time, ms       | warn                                 |
| `js`                 | JavaScript transfer bytes      | error                                |
| `css`                | Stylesheet transfer bytes      | warn                                 |
| `fonts`              | Font transfer bytes            | warn                                 |
| `images`             | Image transfer bytes           | warn                                 |
| `total`              | All transfer bytes             | warn                                 |
| `requests`           | Request count                  | error                                |
| `thirdPartyBytes`    | Third-party transfer bytes     | warn                                 |
| `thirdPartyRequests` | Third-party request count      | warn                                 |
| `longTasks`          | Main-thread tasks ≥ 50 ms      | warn                                 |
| `a11y`               | Accessibility violation nodes  | error                                |

`max` is compared against the median of the measured runs. The first run is a warm-up and is
never reported or compared.

## Per-URL overrides

A URL entry can be a string or an object. Page-level `preset`, `runs` and `budgets` override
the global values; budget rules deep-merge, so a page can tighten one metric without
restating the rest.

```json
{
  "urls": [
    "https://example.com/",
    {
      "url": "https://example.com/app",
      "preset": "desktop",
      "runs": 5,
      "budgets": {
        "js": { "max": "900kb" },
        "thirdPartyRequests": { "max": 10 }
      }
    }
  ]
}
```

Baselines are keyed by `preset::url`, so the same URL can have independent mobile and desktop
baselines without one overwriting the other.

## Authenticated pages

A page target can carry an `auth` block. Bearer tokens and Basic credentials are resolved from
the environment at run time and applied to every request in the Lighthouse run:

```json
{
  "urls": [
    {
      "url": "https://staging.example.com/app",
      "auth": { "type": "bearer", "token": "${PULSE_TOKEN}" }
    },
    {
      "url": "https://staging.example.com/admin",
      "auth": { "type": "basic", "username": "${PULSE_USER}", "password": "${PULSE_PASS}" }
    }
  ]
}
```

A missing or empty environment variable fails before Chrome launches, and the secret is never
written to the report or baseline. Because Lighthouse applies the header to every request in
the run, use a token scoped to the staging environment rather than production.

## API endpoints and budgets

`api` entries are measured with a direct HTTP request instead of Lighthouse. They are reported
in a separate **API timings** table and store their own baseline keyed by method and URL. A
config may set `"urls": []` to run API checks only; at least one page URL or API endpoint is
required.

```json
{
  "api": [
    {
      "url": "https://api.example.com/v1/items",
      "method": "GET",
      "auth": { "type": "bearer", "token": "${PULSE_TOKEN}" },
      "runs": 3,
      "timeoutMs": 5000,
      "expectStatus": [200],
      "budgets": {
        "ttfb": { "max": "300ms", "regression": 20 },
        "duration": { "max": "800ms", "regression": 20 },
        "bytes": { "regression": 25, "severity": "warn" }
      }
    }
  ],
  "apiBudgets": {
    "ttfb": { "regression": 20, "severity": "warn" },
    "duration": { "regression": 20, "severity": "warn" }
  }
}
```

| Key        | Measures                              | Default in `apiBudgets` |
| ---------- | ------------------------------------- | ----------------------- |
| `ttfb`     | Time until response headers, ms       | regression 20%, warn    |
| `duration` | Time until the body has been read, ms | regression 20%, warn    |
| `bytes`    | Response body size                    | not gated               |

Per-endpoint budgets deep-merge over `apiBudgets`. Unlike pages, API runs are **not warmed up**:
`runs` requests are executed, so POST/PUT/PATCH/DELETE targets repeat their side effect. Use
`runs: 1` for unsafe methods when that matters. An API baseline is ignored when the measured
run count changes.

HTTP status is always reported. By default 2xx–3xx passes; anything else warns. Set
`expectStatus` to one code or a list of codes to make a mismatch fail instead.

## Why both `max` and `regression`

A pure absolute budget fails on a permanently slow page even when a PR improves it. A pure
regression budget lets a page drift upward forever. Pulse combines them:

| Situation                                         | Result                                       |
| ------------------------------------------------- | -------------------------------------------- |
| Under `max`, small change                         | pass                                         |
| Over `max`, no baseline                           | fail (or warn for a `warn` rule)             |
| Over `max`, but improved versus baseline          | pass, with the overshoot shown in the report |
| Under `max`, but regressed more than `regression` | fail                                         |
| Over `max` and regressed                          | fail                                         |
| Over `max` while improving, with `"strict": true` | fail                                         |

The "over max but improved" case is the ratchet: the tool is a regression gate, not a
compliance auditor. It applies to `error` rules; a `warn` rule that is over `max` but improving
still reports a warning. When a rule has only `max`, there is no tolerance to excuse an
increase, so the metric must stay flat or improve for the ratchet to apply. Set
`"strict": true` (top level, default `false`) when absolute compliance should be enforced now.
In strict mode, absolute breaches on `error` rules fail even when the page improved; warnings
stay warnings.

## Severity

`lcp`, `cls`, `fcp`, `js`, `requests` and accessibility default to `error`. `tbt`, `ttfb`,
`css`, `fonts`, `images`, `total`, `longTasks` and both third-party metrics default to `warn`
in the generated config. A failing `warn` check is reported but does not set a non-zero exit
code unless you run with `--fail-on warn`. Override per rule:

```json
{ "tbt": { "max": "200ms", "severity": "warn" } }
```

## CI variance

Shared runners are noisier than a laptop. Every measured run is stored in
`AuditResult.samples`, and the terminal, Markdown and HTML reports show a run-spread line
when more than one sample exists.

- Use `"runs": 5` on GitHub-hosted runners; keep `regression` tolerances at 10–20%.
- Prefer leaving `tbt`, `ttfb`, `css`, `fonts`, `total` and third-party metrics as `warn`.
- If a metric swings by more than 10% between identical runs, widen its budget instead of
  disabling the check; a flaky gate teaches people to ignore it.
- Use the spread line to tell a real regression from noise before tightening a budget.

## Accessibility

`maxViolations` caps the total number of violation nodes. `maxNew` caps nodes that were not
in the baseline; `maxNewByImpact` does the same per axe impact level (`critical`, `serious`,
`moderate`, `minor`). Keys include the rule id, selector and failure summary, so selector
churn does not create fake new debt.

A config generated by `pulse init --from` sets `maxViolations` to the page's current debt and
gates new debt only:

```json
{
  "a11y": {
    "maxViolations": 12,
    "maxNew": 0,
    "maxNewByImpact": { "critical": 0, "serious": 0 }
  }
}
```

The static default config uses `maxViolations: 0`, so a fresh project also has a total ceiling.

A11y rules must set at least one of `maxViolations`, `maxNew` or `maxNewByImpact`. Without a
baseline, nothing counts as new: existing violations are recorded against `maxViolations` but
the first run can seed a baseline without failing on inherited debt. A present but
incomparable baseline behaves like no baseline.

### `ignoreRules`

`ignoreRules` is a list of axe rule ids that are removed from both the audit and the baseline
before comparison. Use it for findings you have explicitly accepted, not to hide a regression:

```json
{ "a11y": { "maxNewByImpact": { "critical": 0 }, "ignoreRules": ["color-contrast"] } }
```

Ignored rules also disappear from the displayed violation count, so the report and the gate
cannot disagree.

## Choosing numbers

`pulse init --from https://example.com` measures the page with the configured run count and
applies headroom, so you start from a definition the page can actually hit. Review and
tighten it once fixes land.

| Metric               | Headroom applied by `init --from`                                                  |
| -------------------- | ---------------------------------------------------------------------------------- |
| LCP                  | current + 500 ms (minimum 1000 ms)                                                 |
| CLS                  | 0.05 (or current + 0.02)                                                           |
| TBT                  | current + 100 ms (minimum 200 ms), warning                                         |
| FCP                  | current + 500 ms (minimum 1800 ms)                                                 |
| TTFB                 | current + 200 ms (minimum 800 ms), warning                                         |
| JavaScript           | current + 20%, minimum 50 KB                                                       |
| CSS                  | current + 20%, minimum 100 KB, warning                                             |
| Fonts                | current + 20%, minimum 300 KB, warning                                             |
| Images               | current + 20%, minimum 100 KB                                                      |
| Total                | current + 20%, minimum 1.5 MB, warning                                             |
| Requests             | current + 10 (minimum 20)                                                          |
| Third-party bytes    | current + 20%, minimum 300 KB, warning                                             |
| Third-party requests | current + 10, minimum 20, warning                                                  |
| Long tasks           | current + 2 (minimum 10), regression 20%, warning                                  |
| A11y                 | `maxNew: 0`, critical/serious buckets at 0, `maxViolations` equal to today's count |

Tighten after the first fixes land. A budget you cannot hit is a budget people disable.
