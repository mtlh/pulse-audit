import type { A11yImpact } from '../types.js';

/** axe impact levels, most severe first. Shared by extraction and reporting. */
export const IMPACT_ORDER: readonly A11yImpact[] = ['critical', 'serious', 'moderate', 'minor'];

/** Narrow an axe/Lighthouse value to a known impact level. */
export function isA11yImpact(value: unknown): value is A11yImpact {
  return value === 'critical' || value === 'serious' || value === 'moderate' || value === 'minor';
}
