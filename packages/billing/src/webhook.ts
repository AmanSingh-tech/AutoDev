import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stripe's signature scheme: `Stripe-Signature: t=<unix>,v1=<hex hmac of "t.payload">`. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeSignatureError extends Error {
  override name = 'StripeSignatureError';
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> & { id: string } };
}

/** Verifies and parses a webhook body. Rejects bad signatures and replays older than the tolerance. */
export function verifyStripeEvent(secret: string, raw: Buffer, header: string | undefined, now = Date.now()): StripeEvent {
  if (!header) throw new StripeSignatureError('missing Stripe-Signature');
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || signatures.length === 0) throw new StripeSignatureError('malformed Stripe-Signature');
  if (Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) throw new StripeSignatureError('timestamp outside the tolerance');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const ok = signatures.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new StripeSignatureError('signature mismatch');
  return JSON.parse(raw.toString('utf8')) as StripeEvent;
}

/** For tests and the e2e mock: a valid header for `raw`. */
export function signStripePayload(secret: string, raw: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
