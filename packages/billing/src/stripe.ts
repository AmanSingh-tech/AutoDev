/**
 * The few Stripe calls AutoDev makes, over Stripe's REST API (form-encoded, as Stripe expects).
 * The secret key is only ever sent to Stripe. `apiUrl` is configurable so tests use a mock.
 */
export interface StripeConfig {
  secretKey: string;
  apiUrl: string;
}

export class StripeError extends Error {
  override name = 'StripeError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `{ a: { b: [1] } }` → `a[b][0]=1`, Stripe's nested form encoding. */
export function formEncode(params: Record<string, unknown>, prefix = ''): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => out.push(typeof item === 'object' ? formEncode(item as Record<string, unknown>, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`));
    else if (typeof v === 'object') out.push(formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: { data: { id: string; quantity: number; price: { id: string }; current_period_end?: number }[] };
}

export class StripeClient {
  constructor(private readonly cfg: StripeConfig) {}

  private async request<T>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>): Promise<T> {
    const body = params ? formEncode(params) : undefined;
    const url = `${this.cfg.apiUrl}/v1/${path}${method === 'GET' && body ? `?${body}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.cfg.secretKey}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new StripeError(res.status, json.error?.message ?? `Stripe answered ${res.status}`);
    return json as T;
  }

  /** A hosted checkout page for a per-seat subscription. The org id rides along in metadata. */
  createCheckoutSession(input: { orgId: string; priceId: string; seats: number; customerId?: string | null; email?: string | null; successUrl: string; cancelUrl: string }) {
    return this.request<{ id: string; url: string }>('POST', 'checkout/sessions', {
      mode: 'subscription',
      client_reference_id: input.orgId,
      ...(input.customerId ? { customer: input.customerId } : input.email ? { customer_email: input.email } : {}),
      line_items: [{ price: input.priceId, quantity: input.seats }],
      subscription_data: { metadata: { org_id: input.orgId } },
      metadata: { org_id: input.orgId },
      allow_promotion_codes: true,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
  }

  /** Stripe's own page for invoices, payment methods and cancelling. */
  createPortalSession(customerId: string, returnUrl: string) {
    return this.request<{ url: string }>('POST', 'billing_portal/sessions', { customer: customerId, return_url: returnUrl });
  }

  getSubscription(id: string) {
    return this.request<StripeSubscription>('GET', `subscriptions/${encodeURIComponent(id)}`);
  }

  /** Changes the seat count, prorated on the next invoice. */
  setQuantity(itemId: string, quantity: number) {
    return this.request<{ id: string; quantity: number }>('POST', `subscription_items/${encodeURIComponent(itemId)}`, { quantity, proration_behavior: 'create_prorations' });
  }
}
