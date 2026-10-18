import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { busyKey, presenceKey, type BlobStore, type BuilderJobs } from '@autodev/agent';
import { eq, schema, type SystemDb } from '@autodev/db';
import type { KvCache } from '@autodev/github';
import { HEARTBEAT_INTERVAL_MS, OFFLINE_AFTER_MS, parseBuilderMessage, parseGatewayMessage, PROTOCOL_VERSION, type BuilderMessage, type GatewayMessage } from '@autodev/protocol';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';

const { builders } = schema;

export const channelOf = (builderId: string) => `builder:${builderId}`;
const logsKey = (jobId: string) => `job:logs:${jobId}`;
export const OFFER_TIMEOUT_MS = 30_000;
const MAX_LOG_ENTRIES = 20_000;

export interface GatewayDeps {
  sys: SystemDb;
  /** Commands (presence, logs, publish). */
  redis: Redis;
  /** A dedicated connection in subscriber mode. */
  sub: Redis;
  cache: KvCache;
  blobs: BlobStore;
  jobs: BuilderJobs;
  log: Logger;
  offerTimeoutMs?: number;
  offlineAfterMs?: number;
}

interface Conn {
  ws: WebSocket;
  builderId: string;
  orgId: string;
  lastSeen: number;
  offerTimers: Map<string, NodeJS.Timeout>;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The builder gateway. Builders connect out to it (no inbound ports on developer machines),
 * authenticate with a bearer token, and receive offers routed over Redis pub/sub, so any gateway
 * instance can serve any builder.
 */
export function createGateway(deps: GatewayDeps): { server: Server; close: () => Promise<void> } {
  const conns = new Map<string, Conn>();
  const offerTimeout = deps.offerTimeoutMs ?? OFFER_TIMEOUT_MS;
  const offlineAfter = deps.offlineAfterMs ?? OFFLINE_AFTER_MS;

  const server = createServer((req, res) => {
    if (req.url === '/healthz') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    try {
      if (!req.url?.startsWith('/builder')) throw new Error('not found');
      const builder = await authenticate(req);
      if (!builder) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, builder));
    } catch {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  async function authenticate(req: IncomingMessage) {
    const token = /^Bearer (adb_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return null;
    const [b] = await deps.sys.select().from(builders).where(eq(builders.tokenHash, hashToken(token)));
    return b && !b.revokedAt ? b : null;
  }

  async function onConnect(ws: WebSocket, b: typeof builders.$inferSelect) {
    // One connection per builder: a new one replaces the old.
    conns.get(b.id)?.ws.close(4000, 'replaced by a newer connection');
    const conn: Conn = { ws, builderId: b.id, orgId: b.orgId, lastSeen: Date.now(), offerTimers: new Map() };
    conns.set(b.id, conn);
    await deps.sub.subscribe(channelOf(b.id));
    deps.log.info({ builderId: b.id }, 'builder connected');

    ws.on('message', (raw) => {
      conn.lastSeen = Date.now();
      const msg = parseBuilderMessage(raw.toString());
      if (!msg) return void ws.close(4002, 'invalid message');
      handle(conn, msg).catch((err) => deps.log.error({ err, builderId: b.id, type: msg.type }, 'builder message failed'));
    });
    ws.on('close', () => {
      if (conns.get(b.id) !== conn) return; // replaced
      conns.delete(b.id);
      for (const t of conn.offerTimers.values()) clearTimeout(t);
      void (async () => {
        await deps.sub.unsubscribe(channelOf(b.id));
        await deps.cache.del(presenceKey(b.id));
        await deps.jobs.disconnected(b.id);
        deps.log.info({ builderId: b.id }, 'builder disconnected');
      })().catch((err) => deps.log.error({ err }, 'disconnect cleanup failed'));
    });
  }

  async function markSeen(conn: Conn) {
    await deps.cache.set(presenceKey(conn.builderId), String(Date.now()), Math.ceil(offlineAfter / 1000));
  }

  async function handle(conn: Conn, msg: BuilderMessage) {
    switch (msg.type) {
      case 'hello': {
        await deps.sys
          .update(builders)
          .set({ os: msg.os, arch: msg.arch, cliVersion: msg.cliVersion, dockerAvailable: msg.dockerAvailable, lastSeenAt: new Date() })
          .where(eq(builders.id, conn.builderId));
        await markSeen(conn);
        send(conn, { type: 'hello', protocol: PROTOCOL_VERSION, builderId: conn.builderId, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
        // Anything queued while it was offline goes out now.
        if (!msg.runningJobId) await deps.jobs.dispatchFor(conn.builderId);
        return;
      }
      case 'heartbeat':
        await markSeen(conn);
        await deps.sys.update(builders).set({ lastSeenAt: new Date() }).where(eq(builders.id, conn.builderId));
        return;
      case 'job.accept':
        clearOfferTimer(conn, msg.jobId);
        await deps.jobs.accepted(conn.builderId, msg.jobId);
        return;
      case 'job.reject':
        clearOfferTimer(conn, msg.jobId);
        await deps.jobs.released(conn.builderId, msg.jobId, `rejected: ${msg.reason}`);
        return;
      case 'log.chunk': {
        if ((await deps.cache.get(busyKey(conn.builderId))) !== msg.jobId) return; // not this builder's job
        const key = logsKey(msg.jobId);
        await deps.redis.multi().rpush(key, JSON.stringify({ seq: msg.seq, step: msg.step, stream: msg.stream, data: msg.data, ts: Date.now() })).ltrim(key, -MAX_LOG_ENTRIES, -1).expire(key, 24 * 3600).exec();
        return;
      }
      case 'job.result': {
        if ((await deps.cache.get(busyKey(conn.builderId))) !== msg.jobId) return;
        const entries = await deps.redis.lrange(logsKey(msg.jobId), 0, -1);
        const text = entries.map((e) => JSON.parse(e) as { step: string; data: string }).map((e) => e.data).join('');
        const [job] = await deps.sys.select({ orgId: schema.builderJobs.orgId }).from(schema.builderJobs).where(eq(schema.builderJobs.id, msg.jobId));
        let logKey: string | null = null;
        if (job) {
          logKey = `jobs/${msg.jobId}/log.txt`;
          await deps.blobs.put(job.orgId, logKey, text, 'text/plain');
        }
        await deps.jobs.finished(conn.builderId, msg, logKey);
        return;
      }
    }
  }

  function send(conn: Conn, msg: GatewayMessage) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  function clearOfferTimer(conn: Conn, jobId: string) {
    const t = conn.offerTimers.get(jobId);
    if (t) clearTimeout(t);
    conn.offerTimers.delete(jobId);
  }

  // Messages for builders, from any instance (worker, API, other gateways).
  deps.sub.on('message', (channel, raw) => {
    const builderId = channel.slice('builder:'.length);
    const conn = conns.get(builderId);
    const msg = parseGatewayMessage(raw);
    if (!conn || !msg) return;
    send(conn, msg);
    if (msg.type === 'job.offer') {
      conn.offerTimers.set(
        msg.jobId,
        setTimeout(() => {
          conn.offerTimers.delete(msg.jobId);
          void deps.jobs.released(builderId, msg.jobId, 'offer not accepted in time');
        }, offerTimeout),
      );
    }
  });

  // A builder that goes quiet for longer than the offline window is dropped.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const conn of conns.values()) if (now - conn.lastSeen > offlineAfter) conn.ws.terminate();
  }, Math.min(10_000, offlineAfter / 2));

  return {
    server,
    close: async () => {
      clearInterval(sweeper);
      for (const c of conns.values()) c.ws.close(1001, 'gateway shutting down');
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** What the API's dispatcher (and the worker) use to reach a builder through whichever gateway holds it. */
export const redisBus = (redis: Redis) => ({
  send: async (builderId: string, msg: GatewayMessage) => void (await redis.publish(channelOf(builderId), JSON.stringify(msg))),
});
