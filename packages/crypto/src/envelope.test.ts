import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoError, createWrappedDataKey, Envelope, last4, LocalMasterKeyWrapper } from './index';

const kms = new LocalMasterKeyWrapper(randomBytes(32).toString('base64'), 'local-v1');

async function orgEnvelope(orgId: string) {
  const { wrapped } = await createWrappedDataKey(kms, `org:${orgId}`);
  return new Envelope(kms, wrapped, `org:${orgId}`);
}

describe('Envelope', () => {
  it('round-trips a secret', async () => {
    const env = await orgEnvelope('o1');
    const blob = await env.encrypt('sk-ant-secret-1234', 'llm_credentials:c1');
    expect(blob.toString('utf8')).not.toContain('sk-ant');
    await expect(env.useSecret(blob, 'llm_credentials:c1', (s) => s)).resolves.toBe(
      'sk-ant-secret-1234',
    );
  });

  it('rejects a ciphertext moved to another row (AAD mismatch)', async () => {
    const env = await orgEnvelope('o1');
    const blob = await env.encrypt('secret', 'llm_credentials:c1');
    await expect(env.useSecret(blob, 'llm_credentials:c2', (s) => s)).rejects.toThrow(CryptoError);
  });

  it("rejects decryption with another org's data key", async () => {
    const a = await orgEnvelope('a');
    const b = await orgEnvelope('b');
    const blob = await a.encrypt('secret', 'row:1');
    await expect(b.useSecret(blob, 'row:1', (s) => s)).rejects.toThrow(CryptoError);
  });

  it('rejects a data key unwrapped under the wrong context', async () => {
    const { wrapped } = await createWrappedDataKey(kms, 'org:a');
    const env = new Envelope(kms, wrapped, 'org:b');
    await expect(env.encrypt('x', 'row:1')).rejects.toThrow(CryptoError);
  });

  it('rejects tampered ciphertext', async () => {
    const env = await orgEnvelope('o1');
    const blob = await env.encrypt('secret', 'row:1');
    blob[blob.length - 20]! ^= 0xff;
    await expect(env.useSecret(blob, 'row:1', (s) => s)).rejects.toThrow('decryption failed');
  });

  it('shows only the last 4 chars', () => {
    expect(last4('sk-ant-abcdWXYZ')).toBe('WXYZ');
  });
});
