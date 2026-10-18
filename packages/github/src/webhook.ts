import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verifies GitHub's X-Hub-Signature-256 header over the raw request body. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'),
    'utf8',
  );
  const actual = Buffer.from(signatureHeader, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
