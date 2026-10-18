import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API, server, testCfg } from '../test/helpers';
import { userOctokit } from './clients';
import { PushNotAllowed } from './errors';
import { assertCanPush, canPush, highestPermission } from './permissions';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('highestPermission', () => {
  it('picks the strongest flag', () => {
    expect(highestPermission({ admin: false, maintain: true, push: true, pull: true })).toBe('maintain');
    expect(highestPermission({ pull: true, triage: true })).toBe('triage');
    expect(highestPermission({})).toBeNull();
    expect(highestPermission(undefined)).toBeNull();
  });
  it('treats only push, maintain and admin as writable', () => {
    expect(['admin', 'maintain', 'push'].every((p) => canPush(p as never))).toBe(true);
    expect(canPush('triage')).toBe(false);
    expect(canPush('pull')).toBe(false);
    expect(canPush(null)).toBe(false);
  });
});

describe('assertCanPush (live check)', () => {
  const repoResponse = (permissions: object, archived = false) =>
    http.get(`${API}/repos/acme/web`, () => HttpResponse.json({ id: 1, archived, permissions }));

  it('passes when the user can push', async () => {
    server.use(repoResponse({ push: true, pull: true }));
    await expect(assertCanPush(userOctokit(testCfg, 't'), 'acme', 'web')).resolves.toBe('push');
  });

  it('fails when the permission was downgraded to read', async () => {
    server.use(repoResponse({ pull: true }));
    await expect(assertCanPush(userOctokit(testCfg, 't'), 'acme', 'web')).rejects.toBeInstanceOf(PushNotAllowed);
  });

  it('fails on an archived repo even with admin', async () => {
    server.use(repoResponse({ admin: true }, true));
    await expect(assertCanPush(userOctokit(testCfg, 't'), 'acme', 'web')).rejects.toBeInstanceOf(PushNotAllowed);
  });

  it('fails when the repo is no longer visible to the user', async () => {
    server.use(http.get(`${API}/repos/acme/web`, () => new HttpResponse(null, { status: 404 })));
    await expect(assertCanPush(userOctokit(testCfg, 't'), 'acme', 'web')).rejects.toBeInstanceOf(PushNotAllowed);
  });
});
