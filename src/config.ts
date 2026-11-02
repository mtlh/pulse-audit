import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AuditResult, PulseConfig } from './types.js';

const budgetRuleSchema = z
  .object({
    max: z.number().nonnegative().optional(),
    regression: z.number().nonnegative().max(100).optional(),
    severity: z.enum(['error', 'warn']).optional(),
  })
  .strict();

const a11yBudgetSchema = budgetRuleSchema.extend({
  maxViolations: z.number().int().nonnegative().optional(),
  maxNew: z.number().int().nonnegative().optional(),
});

export const configSchema = z
  .object({
    preset: z.enum(['mobile', 'desktop']).default('mobile'),
    runs: z.number().int().min(1).max(10).default(3),
    urls: z.array(z.string().url()).min(1),
    budgets: z
      .object({
        lcp: budgetRuleSchema.optional(),
        cls: budgetRuleSchema.optional(),
        tbt: budgetRuleSchema.optional(),
        js: budgetRuleSchema.optional(),
        images: budgetRuleSchema.optional(),
        requests: budgetRuleSchema.optional(),
        a11y: a11yBudgetSchema.optional(),
      })
      .default({}),
    report: z
      .object({
        outDir: z.string().min(1).default('.pulse'),
      })
      .default({}),
  })
  .strict();

export class PulseConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'PulseConfigError';
  }
}

export async function loadConfig(path = '.pulse.json'): Promise<PulseConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new PulseConfigError(`No config found at ${path}. Run "pulse init" first.`, path);
    }
    throw new PulseConfigError(`Could not read ${path}: ${(error as Error).message}`, path);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new PulseConfigError(`Invalid config at ${path}:\n${issues}`, path);
  }

  return parsed.data as PulseConfig;
}

export function budgetsFromResult(result: AuditResult): PulseConfig['budgets'] {
  const roundUp = (value: number, step: number): number => Math.ceil(value / step) * step;
  const metrics = result.metrics;

  return {
    lcp: { max: Math.max(1000, roundUp(metrics.lcp + 500, 100)), regression: 10 },
    cls: { max: Math.max(0.05, Math.ceil((metrics.cls + 0.02) * 1000) / 1000), regression: 20 },
    tbt: { max: Math.max(200, roundUp(metrics.tbt + 100, 50)), severity: 'warn' },
    js: { max: Math.max(50_000, roundUp(metrics.js * 1.2, 1024)), regression: 10 },
    images: { max: Math.max(100_000, roundUp(metrics.images * 1.2, 1024)), regression: 10 },
    requests: { max: Math.max(20, metrics.requests + 10), regression: 10 },
    // Existing debt becomes the ceiling; new debt is what a PR should block.
    a11y: { maxViolations: metrics.violations, maxNew: 0 },
  };
}

export function defaultConfig(urls: string[]): PulseConfig {
  return {
    preset: 'mobile',
    runs: 3,
    urls,
    budgets: {
      lcp: { max: 2500, regression: 10 },
      cls: { max: 0.05, regression: 20 },
      tbt: { max: 200, severity: 'warn' },
      js: { max: 250_000, regression: 10 },
      images: { max: 600_000, regression: 10 },
      requests: { max: 90, regression: 10 },
      a11y: { maxViolations: 0, maxNew: 0 },
    },
    report: { outDir: '.pulse' },
  };
}

export async function writeConfig(path: string, config: PulseConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
