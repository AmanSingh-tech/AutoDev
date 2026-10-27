/**
 * The few Jira Cloud REST calls AutoDev needs (B-7), with an Atlassian account's email and API
 * token. Requests only ever go to https://<site>.atlassian.net: the site is a checked name, so an
 * admin's setting can't point the token anywhere else.
 */
export const JIRA_SITE = /^[a-z0-9][a-z0-9-]{0,61}$/i;
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface JiraCredentials {
  site: string;
  email: string;
  token: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  url: string;
}

/** Atlassian Document Format paragraphs, which Jira's v3 API wants for descriptions and comments. */
export function adf(paragraphs: { text: string; href?: string }[][]) {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((runs) => ({
      type: 'paragraph',
      content: runs.filter((r) => r.text).map((r) => ({ type: 'text', text: r.text, ...(r.href ? { marks: [{ type: 'link', attrs: { href: r.href } }] } : {}) })),
    })),
  };
}

export class JiraClient {
  /** `baseUrl` is a test-only override; production always uses the site's atlassian.net address. */
  constructor(
    private readonly creds: JiraCredentials,
    private readonly baseUrl?: string,
  ) {
    if (!JIRA_SITE.test(creds.site)) throw new JiraError('Not a valid Jira site name', 400);
  }

  get siteUrl() {
    return this.baseUrl ?? `https://${this.creds.site}.atlassian.net`;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.siteUrl}/rest/api/3${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.creds.email}:${this.creds.token}`).toString('base64')}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new JiraError('Could not reach Jira', 0);
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as T & { errorMessages?: string[]; errors?: Record<string, string> };
    if (!res.ok) {
      const detail = data.errorMessages?.[0] ?? Object.values(data.errors ?? {})[0];
      const msg = res.status === 401 ? 'Jira rejected the email or API token' : res.status === 404 ? 'Not found in Jira (or no access)' : (detail ?? `Jira ${res.status}`);
      throw new JiraError(msg, res.status);
    }
    return data;
  }

  /** Proves the credentials work; returns the account's display name. */
  async myself(): Promise<{ displayName: string }> {
    return this.request('GET', '/myself');
  }

  async issue(key: string): Promise<JiraIssue> {
    if (!JIRA_ISSUE_KEY.test(key)) throw new JiraError('Not a Jira issue key (like PROJ-123)', 400);
    const data = await this.request<{ key: string; fields: { summary: string; status?: { name: string } } }>('GET', `/issue/${encodeURIComponent(key)}?fields=summary,status`);
    return { key: data.key, summary: data.fields.summary, status: data.fields.status?.name ?? '', url: `${this.siteUrl}/browse/${data.key}` };
  }

  async createIssue(input: { project: string; summary: string; description: ReturnType<typeof adf>; issueType?: string }): Promise<{ key: string }> {
    if (!JIRA_PROJECT_KEY.test(input.project)) throw new JiraError('Not a Jira project key', 400);
    return this.request('POST', '/issue', {
      fields: { project: { key: input.project }, summary: input.summary.slice(0, 250), description: input.description, issuetype: { name: input.issueType ?? 'Task' } },
    });
  }

  async comment(key: string, body: ReturnType<typeof adf>): Promise<void> {
    await this.request('POST', `/issue/${encodeURIComponent(key)}/comment`, { body });
  }
}
