import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const npmCli =
  process.env.npm_execpath ??
  [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules/npm/bin/npm-cli.js'),
  ].find(existsSync);

if (!npmCli) {
  console.error('Could not find npm-cli.js. Run this script through npm.');
  process.exit(1);
}

function run(command, args, env = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [npmCli, 'run', 'build']);
run(
  process.execPath,
  [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', path.resolve('vitest.flows.config.ts')],
  {
    PULSE_E2E: '1',
    PULSE_PACKAGE: process.env.PULSE_PACKAGE ?? '1',
  },
);
