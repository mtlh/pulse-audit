import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isEnoent } from './errors.js';

/**
 * File helpers shared by the config, baseline and report writers.
 *
 * Every writer creates its parent directory and ends text files with a newline,
 * so configs, baselines and reports have one consistent on-disk shape.
 */

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/** Reads a text file, returning `undefined` when it does not exist. */
export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readTextFile(path)) as unknown;
}

/** Writes two-space JSON with a trailing newline, the shape every Pulse file uses. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
