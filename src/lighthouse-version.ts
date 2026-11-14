import lighthousePackage from 'lighthouse/package.json' with { type: 'json' };

/**
 * The bundled Lighthouse version, kept in its own module so `pulse doctor` can
 * report it without importing the Lighthouse runtime.
 */
export const LIGHTHOUSE_VERSION: string = lighthousePackage.version;
