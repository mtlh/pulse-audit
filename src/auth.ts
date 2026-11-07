import type { AuthConfig } from './types.js';

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expands `${VAR}` placeholders from the environment. Expansion happens at run
 * time so a config file can be committed with placeholders instead of secrets.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_PATTERN, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved.length === 0) {
      throw new Error(`Environment variable ${name} is not set (or is empty)`);
    }
    return resolved;
  });
}

export function resolveAuthHeaders(
  auth: AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (auth.type === 'bearer') {
    return { Authorization: `Bearer ${expandEnv(auth.token, env)}` };
  }

  const username = expandEnv(auth.username, env);
  const password = expandEnv(auth.password, env);
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

/**
 * Expands custom headers and adds the auth header last. An explicit `auth`
 * block therefore wins over a hand-written Authorization header.
 */
export function resolveRequestHeaders(
  auth: AuthConfig | undefined,
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    resolved[name] = expandEnv(value, env);
  }

  if (auth) {
    // HTTP header names are case-insensitive; remove a hand-written value before
    // the auth block writes the canonical one.
    for (const name of Object.keys(resolved)) {
      if (name.toLowerCase() === 'authorization') delete resolved[name];
    }
    Object.assign(resolved, resolveAuthHeaders(auth, env));
  }
  return resolved;
}
