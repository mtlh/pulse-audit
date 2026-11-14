import axePackage from 'axe-core/package.json' with { type: 'json' };
import { axeSource } from 'lighthouse/core/lib/axe.js';

/**
 * The exact axe build Lighthouse 13.6 uses. `--fast` injects this source into
 * the page, so its results stay comparable with a Lighthouse baseline. Both
 * values are inlined at build time; a production install does not contain
 * axe-core or Lighthouse on disk.
 */
export const AXE_SOURCE: string = axeSource;
export const AXE_VERSION: string = axePackage.version;
