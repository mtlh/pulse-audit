import { readFileSync } from 'node:fs';

interface PackageJson {
  version?: unknown;
}

/**
 * Reads the published version from package.json at runtime.
 *
 * `import.meta.url` resolves to `src/version.ts` during development and to
 * `dist/cli.js` in the bundle, so `../package.json` lands on the package root
 * in both cases. Keeping one source avoids `--version` drifting from npm.
 */
function readVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageJson;

    if (typeof packageJson.version === 'string' && packageJson.version.length > 0) {
      return packageJson.version;
    }
  } catch {
    // Fall through to a clearly unresolved marker rather than a stale literal.
  }

  return '0.0.0-unknown';
}

export const VERSION = readVersion();
