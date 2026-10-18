import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, schema } from '@autodev/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';

const { builderRepoBindings, builders, repos } = schema;

export const PAIRING_TTL_SECONDS = 600;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'; // no vowels or look-alikes
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const pairDeviceKey = (deviceCode: string) => `pair:device:${sha(deviceCode)}`;
export const pairUserKey = (userCode: string) => `pair:user:${userCode}`;

export interface PairingState {
  status: 'pending' | 'approved';
  userCode: string;
  name: string;
  token?: string;
  builderId?: string;
  orgSlug?: string;
}

function userCode() {
  const pick = () => Array.from({ length: 4 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

/**
 * REST endpoints for the autodev-runner CLI.
 * Pairing follows the OAuth device flow: the CLI shows a short code, the developer approves it in
 * the dashboard (signed in, in an org), and the CLI's poll then receives its token exactly once.
 */
export async function builderRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.post('/builder/pair/start', async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(64).default('My builder') }).parse(req.body ?? {});
    const deviceCode = randomBytes(32).toString('base64url');
    const code = userCode();
    const state: PairingState = { status: 'pending', userCode: code, name: body.name };
    await deps.cache.set(pairDeviceKey(deviceCode), JSON.stringify(state), PAIRING_TTL_SECONDS);
    await deps.cache.set(pairUserKey(code), sha(deviceCode), PAIRING_TTL_SECONDS);
    return {
      deviceCode,
      userCode: code,
      verificationUri: `${deps.env.WEB_URL}/builders/pair`,
      verificationUriComplete: `${deps.env.WEB_URL}/builders/pair?code=${code}`,
      expiresIn: PAIRING_TTL_SECONDS,
      interval: 3,
    };
  });

  app.post('/builder/pair/poll', async (req, reply) => {
    const { deviceCode } = z.object({ deviceCode: z.string().min(20).max(100) }).parse(req.body);
    const key = pairDeviceKey(deviceCode);
    const raw = await deps.cache.get(key);
    if (!raw) return reply.code(404).send({ status: 'expired' });
    const state = JSON.parse(raw) as PairingState;
    if (state.status === 'pending') return { status: 'pending' };
    // One-time hand-over: the token is gone from Redis after this response.
    await deps.cache.del(key);
    return { status: 'approved', token: state.token, builderId: state.builderId, orgSlug: state.orgSlug, gatewayUrl: deps.env.BUILDER_GATEWAY_URL };
  });

  /** Bearer-authenticated builder calls. */
  async function builderFrom(req: FastifyRequest) {
    const token = /^Bearer (adb_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return null;
    const [b] = await deps.sys.select().from(builders).where(eq(builders.tokenHash, sha(token)));
    return b && !b.revokedAt ? b : null;
  }

  app.get('/builder/me', async (req, reply) => {
    const b = await builderFrom(req);
    if (!b) return reply.code(401).send({ error: 'invalid builder token' });
    return { id: b.id, name: b.name, kind: b.kind, orgId: b.orgId };
  });

  /** `autodev bind`: remember which local clone holds a repo, so jobs reuse its warm caches. */
  app.post('/builder/bindings', async (req, reply) => {
    const b = await builderFrom(req);
    if (!b) return reply.code(401).send({ error: 'invalid builder token' });
    const body = z.object({ repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/), localPath: z.string().min(1).max(1000) }).parse(req.body);
    const [repo] = await deps.sys.select().from(repos).where(and(eq(repos.orgId, b.orgId), eq(repos.fullName, body.repoFullName)));
    if (!repo) return reply.code(404).send({ error: `${body.repoFullName} is not connected to this AutoDev organization` });
    const [row] = await deps.sys
      .insert(builderRepoBindings)
      .values({ builderId: b.id, repoId: repo.id, orgId: b.orgId, localPath: body.localPath })
      .onConflictDoUpdate({ target: [builderRepoBindings.builderId, builderRepoBindings.repoId], set: { localPath: body.localPath } })
      .returning();
    return { repoId: repo.id, confirmed: !!row!.firstRunConfirmedAt };
  });
}
