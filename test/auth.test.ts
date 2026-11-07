import { describe, expect, it } from 'vitest';
import { expandEnv, resolveAuthHeaders, resolveRequestHeaders } from '../src/auth.js';

describe('environment expansion', () => {
  it('replaces ${VAR} placeholders', () => {
    expect(expandEnv('Bearer ${TOKEN}', { TOKEN: 'abc123' })).toBe('Bearer abc123');
    expect(expandEnv('${A}:${B}', { A: 'one', B: 'two' })).toBe('one:two');
  });

  it('leaves values without placeholders alone', () => {
    expect(expandEnv('plain-value', {})).toBe('plain-value');
  });

  it('names the variable when it is missing or empty', () => {
    expect(() => expandEnv('${MISSING}', {})).toThrow(/MISSING/);
    expect(() => expandEnv('${EMPTY}', { EMPTY: '' })).toThrow(/EMPTY/);
  });
});

describe('auth headers', () => {
  it('builds a bearer header and expands the token', () => {
    expect(resolveAuthHeaders({ type: 'bearer', token: '${TOKEN}' }, { TOKEN: 's3cret' })).toEqual({
      Authorization: 'Bearer s3cret',
    });
  });

  it('builds a basic header from username and password', () => {
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    expect(
      resolveAuthHeaders(
        { type: 'basic', username: '${USER}', password: '${PASS}' },
        {
          USER: 'user',
          PASS: 'pass',
        },
      ),
    ).toEqual({ Authorization: expected });
  });

  it('expands custom headers and lets auth win over a hand-written Authorization', () => {
    const headers = resolveRequestHeaders(
      { type: 'bearer', token: 'real-token' },
      { authorization: 'stale', 'X-Env': '${ENV_NAME}' },
      { ENV_NAME: 'staging' },
    );

    expect(headers['X-Env']).toBe('staging');
    expect(headers.Authorization).toBe('Bearer real-token');
    expect(headers.authorization).toBeUndefined();
  });
});
