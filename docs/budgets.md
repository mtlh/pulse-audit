# Budgets

Pulse compares every audit to three things:

1. **The absolute ceiling** (`max`).
2. **The baseline** captured on the same preset and run count.
3. **The tolerable change** (`regression`, a percentage).

## Why both `max` and `regression`

A pure absolute budget fails on a permanently slow page even when a PR improves it. A pure
regression budget lets a page drift upward forever. Pulse combines them:

| Situation | Result |
| --- | --- |
| Under `max`, small change | pass |
| Over `max`, no baseline | fail |
| Over `max`, but improved versus baseline | pass, with the overshoot shown in the report |
| Under `max`, but regressed more than `regression` | fail |
| Over `max` and regressed | fail |

The "over max but improved" case is the ratchet: the tool is a regression gate, not a
compliance auditor. Tighten `max` once the site is fixed, or add `"strict": true` when that
option lands.

## Severity

`lcp`, `cls`, `js` and a11y default to `error`. `tbt` and `images` default to `warn`.
Override per rule:

```json
{ "tbt": { "max": 200, "severity": "warn" } }
```

## CI variance

Shared runners are noisier than a laptop. Use `"runs": 5` on GitHub-hosted runners, keep
`regression` tolerances at 10–20%, and prefer leaving `tbt` and `images` as `warn`. If a metric
swings by more than 10% between identical runs, widen its budget instead of disabling the
check; a flaky gate teaches people to ignore it.

## Accessibility

`maxNew` counts violation nodes that were not in the baseline, keyed by axe rule id and
selector. It is the adoption lever: existing debt does not block a PR, new debt does.
`maxNew` needs a baseline. Before one exists, existing violations are recorded against
`maxViolations` but are not counted as new, so the first run can seed a baseline without
failing on inherited debt. `maxViolations` caps the total so the backlog cannot grow unnoticed.

## Choosing numbers

`pulse init --from https://example.com` measures the page once and applies the following
headroom, so you start from a definition the page can actually hit. Review and tighten it
once the fixes land.

Start from a real run, then add headroom:

- LCP: current median + 500 ms
- CLS: 0.05
- JS: current + 20%
- Requests: current + 10
- A11y: `maxNew: 0`, `maxViolations` equal to today's count

Tighten after the first fixes land. A budget you cannot hit is a budget people disable.
