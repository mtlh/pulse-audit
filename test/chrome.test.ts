import { describe, expect, it } from 'vitest';
import { findChromeBinary, isWsl, type ChromeLookupOptions } from '../src/chrome.js';

function options(overrides: Partial<ChromeLookupOptions> = {}): ChromeLookupOptions {
  return {
    platform: 'linux',
    env: {},
    fileExists: () => false,
    readText: () => '',
    installations: () => [],
    ...overrides,
  };
}

describe('isWsl', () => {
  it('detects WSL from the environment', () => {
    expect(isWsl(options({ env: { WSL_DISTRO_NAME: 'Ubuntu' } }))).toBe(true);
    expect(isWsl(options({ env: { WSL_INTEROP: '/run/WSL/8_interop' } }))).toBe(true);
  });

  it('detects WSL from /proc/version on Linux', () => {
    expect(isWsl(options({ readText: () => 'Linux version 5.15.90.1-microsoft-standard-WSL2' }))).toBe(true);
    expect(isWsl(options({ readText: () => 'Linux version 6.1.0-generic' }))).toBe(false);
  });

  it('does not read /proc/version on non-Linux platforms', () => {
    expect(
      isWsl(
        options({
          platform: 'win32',
          readText: () => 'microsoft-standard-WSL2',
        }),
      ),
    ).toBe(false);
  });
});

describe('findChromeBinary', () => {
  it('prefers CHROME_PATH when it exists', () => {
    const found = findChromeBinary(
      options({
        env: { CHROME_PATH: '/usr/bin/google-chrome' },
        fileExists: (path) => path === '/usr/bin/google-chrome',
      }),
    );

    expect(found.path).toBe('/usr/bin/google-chrome');
    expect(found.source).toBe('CHROME_PATH');
    expect(found.wsl).toBe(false);
  });

  it('reports an unreadable CHROME_PATH', () => {
    const found = findChromeBinary(options({ env: { CHROME_PATH: '/missing/chrome' } }));

    expect(found.path).toBeUndefined();
    expect(found.detail).toContain('/missing/chrome');
    expect(found.detail).toContain('not readable');
  });

  it('uses a system installation before fallback candidates', () => {
    const found = findChromeBinary(
      options({
        installations: () => ['/opt/custom/chrome'],
        fileExists: (path) => path === '/opt/custom/chrome',
      }),
    );

    expect(found.path).toBe('/opt/custom/chrome');
    expect(found.source).toBe('system');
  });

  it('finds snap Chromium inside WSL when chrome-launcher misses it', () => {
    const found = findChromeBinary(
      options({
        readText: () => 'Linux version 5.15.90.1-microsoft-standard-WSL2',
        fileExists: (path) => path === '/snap/bin/chromium',
      }),
    );

    expect(found.path).toBe('/snap/bin/chromium');
    expect(found.source).toBe('candidate');
    expect(found.wsl).toBe(true);
  });

  it('explains that WSL needs a Linux Chrome when none is found', () => {
    const found = findChromeBinary(
      options({ readText: () => 'Linux version 5.15.90.1-microsoft-standard-WSL2' }),
    );

    expect(found.path).toBeUndefined();
    expect(found.wsl).toBe(true);
    expect(found.detail).toContain('WSL detected');
    expect(found.detail).toContain('google-chrome-stable');
  });

  it('warns when WSL is pointed at a Windows chrome.exe', () => {
    const found = findChromeBinary(
      options({
        readText: () => 'Linux version 5.15.90.1-microsoft-standard-WSL2',
        env: { CHROME_PATH: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' },
        fileExists: () => true,
      }),
    );

    expect(found.path).toBe('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe');
    expect(found.warning).toContain('Windows chrome.exe');
  });
});
