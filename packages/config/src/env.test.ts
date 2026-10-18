import { describe, expect, it } from 'vitest';
import { cryptoEnv, githubEnv, loadEnv } from './env';

describe('loadEnv', () => {
  it('rejects a master key that is not 32 bytes', () => {
    expect(() => loadEnv(cryptoEnv, { MASTER_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      /MASTER_KEY: must be 32 bytes/,
    );
  });

  it('accepts a valid master key and applies defaults', () => {
    const env = loadEnv(cryptoEnv, { MASTER_KEY: Buffer.alloc(32, 1).toString('base64') });
    expect(env.KMS_PROVIDER).toBe('local');
    expect(env.MASTER_KEY_ID).toBe('local-v1');
  });

  it('unescapes single-line PEM keys', () => {
    const env = loadEnv(githubEnv, {
      GITHUB_APP_ID: '1',
      GITHUB_APP_SLUG: 'autodev',
      GITHUB_APP_CLIENT_ID: 'Iv1.x',
      GITHUB_APP_CLIENT_SECRET: 's',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN-----\\nabc\\n-----END-----',
      GITHUB_WEBHOOK_SECRET: 'a'.repeat(16),
    });
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe('-----BEGIN-----\nabc\n-----END-----');
    expect(env.GITHUB_API_URL).toBe('https://api.github.com');
  });
});
