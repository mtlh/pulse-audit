/**
 * Lighthouse's own `maxWaitForLoad` default. Pulse sets it explicitly so the
 * audit timeout does not change when Lighthouse does, but it stays at the
 * upstream value: a page that cannot reach a quiet network in 45 s is usually
 * a hung third-party request, and waiting longer only slows CI down.
 */
export const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * The warm-up is best effort (DNS, TLS, server cache, JS warm-up), so it must
 * never dominate a CI run. Cap it well below the measured-run timeout: if it
 * fails, the measured runs still decide the result.
 */
export const WARMUP_TIMEOUT_MS = 10_000;

/**
 * Default number of page URLs audited at once. 2 measured within 0.5% median
 * drift (and no pass/fail flips) against concurrency 1 on the local fixture and
 * the live dogfood page, while halving wall time. Higher values stay opt-in
 * because typical CI runners expose fewer cores than the benchmark host.
 */
export const DEFAULT_CONCURRENCY = 2;
