import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhook';

const secret = 'whsec_test_123456';
const body = JSON.stringify({ action: 'created' });
const sign = (b: string, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(secret, body, sign(body))).toBe(true);
  });
  it('rejects a modified body', () => {
    expect(verifyWebhookSignature(secret, body + ' ', sign(body))).toBe(false);
  });
  it('rejects a signature made with another secret', () => {
    expect(verifyWebhookSignature(secret, body, sign(body, 'other-secret-xxxx'))).toBe(false);
  });
  it('rejects a missing or malformed header', () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=short')).toBe(false);
  });
});
