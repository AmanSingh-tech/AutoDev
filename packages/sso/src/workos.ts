import { createHmac, timingSafeEqual } from 'node:crypto';

/** WorkOS settings. SSO and directory sync are off without the API key and client id. */
export interface WorkosConfig {
  WORKOS_API_KEY?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_WEBHOOK_SECRET?: string;
  WORKOS_API_URL: string;
}

export const ssoEnabled = (c: WorkosConfig) => !!c.WORKOS_API_KEY && !!c.WORKOS_CLIENT_ID;

export class WorkosError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The profile WorkOS returns after an SSO sign-in. */
export interface WorkosProfile {
  id: string;
  idp_id?: string | null;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  organization_id?: string | null;
  connection_id?: string;
}

/** The few WorkOS REST calls AutoDev needs, over fetch. The API key never leaves the server. */
export class WorkosClient {
  constructor(private readonly cfg: { apiKey: string; clientId: string; apiUrl: string }) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, form = false): Promise<T> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: body ? (form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body)) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string; error_description?: string };
    if (!res.ok) throw new WorkosError(data.error_description ?? data.message ?? `WorkOS ${res.status}`, res.status);
    return data;
  }

  /** One WorkOS organization per AutoDev org. */
  createOrganization(name: string, orgId: string): Promise<{ id: string }> {
    return this.request('POST', '/organizations', { name, external_id: orgId });
  }

  /** A short-lived link to WorkOS's setup portal, where the customer's IT admin connects their IdP or directory. */
  portalLink(organization: string, intent: 'sso' | 'dsync' | 'domain_verification', returnUrl: string): Promise<{ link: string }> {
    return this.request('POST', '/portal/generate_link', { organization, intent, return_url: returnUrl });
  }

  /** Where to send the browser to sign in with the org's identity provider. */
  authorizationUrl(input: { organization: string; redirectUri: string; state: string }): string {
    const p = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: input.redirectUri, response_type: 'code', organization: input.organization, state: input.state });
    return `${this.cfg.apiUrl}/sso/authorize?${p}`;
  }

  /** Exchanges the callback code for the signed-in profile. */
  async profile(code: string): Promise<WorkosProfile> {
    const data = await this.request<{ profile: WorkosProfile }>(
      'POST',
      '/sso/token',
      { client_id: this.cfg.clientId, client_secret: this.cfg.apiKey, grant_type: 'authorization_code', code },
      true,
    );
    return data.profile;
  }
}

export class WorkosSignatureError extends Error {}

/** Checks a WorkOS webhook: `WorkOS-Signature: t=<ms>, v1=<hex HMAC-SHA256 of "t.body">`, within 5 minutes. */
export function verifyWorkosWebhook(secret: string, raw: Buffer, header: string | undefined, now = Date.now()): { id: string; event: string; data: Record<string, unknown> } {
  if (!header) throw new WorkosSignatureError('missing signature');
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) throw new WorkosSignatureError('malformed signature');
  if (Math.abs(now - t) > 300_000) throw new WorkosSignatureError('timestamp outside tolerance');
  const expected = createHmac('sha256', secret).update(`${parts.t}.${raw.toString('utf8')}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WorkosSignatureError('signature mismatch');
  return JSON.parse(raw.toString('utf8'));
}

/** Test helper: what WorkOS would send. */
export function signWorkosPayload(secret: string, body: string, t = Date.now()): string {
  return `t=${t}, v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * The `state` round-trips through the identity provider. It's signed and names the org and the
 * signed-in user, so a callback can't be replayed into another org or another person's session.
 */
export function signState(secret: string, s: { orgId: string; userId: string; returnTo: string }, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...s, exp: now + 10 * 60_000 })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(`sso:${body}`).digest('base64url')}`;
}

export function readState(secret: string, state: string, now = Date.now()): { orgId: string; userId: string; returnTo: string } | null {
  const [body, mac] = state.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(`sso:${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { orgId: string; userId: string; returnTo: string; exp: number };
  return s.exp > now ? { orgId: s.orgId, userId: s.userId, returnTo: s.returnTo } : null;
}
