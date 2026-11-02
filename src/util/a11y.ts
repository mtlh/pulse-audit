import type { A11yImpact } from '../types.js';

/** axe impact levels, most severe first. Shared by extraction and reporting. */
export const IMPACT_ORDER: readonly A11yImpact[] = ['critical', 'serious', 'moderate', 'minor'];
