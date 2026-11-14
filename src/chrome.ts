import { accessSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Launcher } from 'chrome-launcher';

export interface ChromeLookupOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  readText?: (path: string) => string;
  installations?: () => string[];
}

export interface ChromeLookup {
  path?: string;
  source?: 'CHROME_PATH' | 'system' | 'candidate';
  wsl: boolean;
  detail: string;
  warning?: string;
}

function defaultFileExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function defaultReadText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * WSL reports `linux` as its platform, so `chrome-launcher` looks for a Linux
 * browser inside the distro. Detect WSL explicitly to explain that requirement
 * instead of failing with a generic "Chrome not found".
 */
export function isWsl(options: ChromeLookupOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  if ((options.platform ?? process.platform) !== 'linux') return false;

  const text = (options.readText ?? defaultReadText)('/proc/version').toLowerCase();
  return text.includes('microsoft') || text.includes('wsl');
}

/** Chrome/Chromium locations that `chrome-launcher` may miss inside WSL. */
export function linuxChromeCandidates(home = homedir()): string[] {
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    join(home, '.local/share/flatpak/exports/bin/com.google.Chrome'),
  ];
}

/**
 * Worker threads on Windows can receive environment keys with their original
 * casing only (`ProgramFiles`), while chrome-launcher looks up the uppercase
 * form. Mirror the aliases so Chrome discovery works in a concurrency lane too.
 */
function ensureWindowsEnvAliases(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  if (platform !== 'win32') return;
  const aliases = [
    ['PROGRAMFILES', 'ProgramFiles'],
    ['PROGRAMFILES(X86)', 'ProgramFiles(x86)'],
    ['LOCALAPPDATA', 'LocalAppData'],
  ] as const;
  for (const [canonical, variant] of aliases) {
    if (!env[canonical] && env[variant]) env[canonical] = env[variant];
  }
}

function wslMissingDetail(): string {
  return [
    'WSL detected, but no Linux Chrome/Chromium was found.',
    'Install Chrome for Linux inside the distro (for example, "sudo apt install google-chrome-stable")',
    'or set CHROME_PATH to a Linux binary such as /usr/bin/google-chrome.',
    'A Windows chrome.exe is not a reliable target because its DevTools port lives on the Windows side.',
  ].join(' ');
}

/**
 * Finds the Chrome binary Pulse should launch. `CHROME_PATH` wins, then the
 * platform's installed browsers, then WSL/Linux fallbacks such as snap and
 * Flatpak. The returned detail is safe to print in `pulse doctor`.
 */
export function findChromeBinary(options: ChromeLookupOptions = {}): ChromeLookup {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  ensureWindowsEnvAliases(env, platform);
  const fileExists = options.fileExists ?? defaultFileExists;
  const wsl = isWsl(options);

  const explicit = env.CHROME_PATH?.trim();
  if (explicit) {
    if (!fileExists(explicit)) {
      return {
        wsl,
        detail: `CHROME_PATH points to ${explicit}, but that file is not readable.`,
      };
    }

    const windowsBinary = wsl && explicit.toLowerCase().endsWith('.exe');
    return {
      path: explicit,
      source: 'CHROME_PATH',
      wsl,
      detail: explicit,
      ...(windowsBinary
        ? {
            warning:
              'CHROME_PATH points to a Windows chrome.exe. WSL often cannot reach that browser’s DevTools port; prefer Chrome for Linux inside WSL.',
          }
        : {}),
    };
  }

  let installations: string[] = [];
  try {
    installations = options.installations ? options.installations() : Launcher.getInstallations();
  } catch {
    installations = [];
  }

  const system = installations.find((path) => fileExists(path));
  if (system) {
    return { path: system, source: 'system', wsl, detail: system };
  }

  if (platform === 'linux') {
    const candidate = linuxChromeCandidates().find((path) => fileExists(path));
    if (candidate) {
      return { path: candidate, source: 'candidate', wsl, detail: candidate };
    }
  }

  return {
    wsl,
    detail: wsl ? wslMissingDetail() : 'Chrome not found. Install Chrome or set CHROME_PATH.',
  };
}
