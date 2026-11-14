import lighthouse from 'lighthouse';
import type * as LighthousePackage from 'lighthouse';
import { LIGHTHOUSE_VERSION } from './lighthouse-version.js';

/**
 * The single Lighthouse entry point used by the runner. Building with
 * `noExternal: ['lighthouse']` turns this module into one lazily loaded chunk,
 * so a production install does not need the Lighthouse package. The build
 * plugin in scripts/lighthouse-build.mjs fills Lighthouse's own bundling seams
 * and fails loudly if a release moves one of them.
 */
export default lighthouse;
export { defaultConfig } from 'lighthouse';
export { LIGHTHOUSE_VERSION };
export type LighthouseModule = typeof LighthousePackage;
