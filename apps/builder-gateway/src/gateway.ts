import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { builderChannel, busyKey, liveLogsKey, presenceKey, publishBus, type BuilderJobs } from '@autodev/agent';
import type { BlobStore } from '@autodev/storage';
import { eq, schema, type SystemDb } from '@autodev/db';
import type { KvCache } from '@autodev/github';
import { HEARTBEAT_INTERVAL_MS, OFFLINE_AFTER_MS, parseBuilderMessage, parseGatewayMessage, PROTOCOL_VERSION, type BuilderMessage, type GatewayMessage } from '@autodev/protocol';
import { emit } from '@autodev/events';
import { taskTopic, userTopic } from '@autodev/protocol';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';

const { builders } = schema;

export const channelOf = builderChannel;
const logsKey = liveLogsKey;
export const OFFER_TIMEOUT_MS = 30_000;
const MAX_LOG_ENTRIES = 20_000;
/** test.log events: at most one per job per interval, and no bigger than this. */
export const LOG_EVENT_INTERVAL_MS = 1000;
export const LOG_EVENT_MAX_CHARS = 16_000;

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
  /** Who sees this builder's presence events. Null for a builder whose owner left. */
  ownerUserId: string | null;
  lastSeen: number;
  offerTimers: Map<string, NodeJS.Timeout>;
  /** Messages from one builder are handled one at a time, in the order they arrived. */
  queue: Promise<void>;
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
    const conn: Conn = { ws, builderId: b.id, orgId: b.orgId, ownerUserId: b.ownerUserId, lastSeen: Date.now(), offerTimers: new Map(), queue: Promise.resolve() };
    conns.set(b.id, conn);
    await deps.sub.subscribe(channelOf(b.id));
    deps.log.info({ builderId: b.id }, 'builder connected');

    ws.on('message', (raw) => {
      conn.lastSeen = Date.now();
      const msg = parseBuilderMessage(raw.toString());
      if (!msg) return void ws.close(4002, 'invalid message');
      // In order: a result must never overtake the log lines sent before it.
      conn.queue = conn.queue
        .then(() => handle(conn, msg))
        .catch((err) => deps.log.error({ err, builderId: b.id, type: msg.type }, 'builder message failed'));
    });
    ws.on('close', () => {
      if (conns.get(b.id) !== conn) return; // replaced
      conns.delete(b.id);
      for (const t of conn.offerTimers.values()) clearTimeout(t);
      void (async () => {
        await deps.sub.unsubscribe(channelOf(b.id));
        await deps.cache.del(presenceKey(b.id));
        await presence(conn, false);
        await deps.jobs.disconnected(b.id);
        deps.log.info({ builderId: b.id }, 'builder disconnected');
      })().catch((err) => deps.log.error({ err }, 'disconnect cleanup failed'));
    });
  }

  async function presence(conn: Conn, online: boolean) {
    if (!conn.ownerUserId) return;
    await emit(deps.redis, { type: 'builder.presence', orgId: conn.orgId, topic: userTopic(conn.ownerUserId), payload: { builderId: conn.builderId, online } });
  }

  // Live test output for the task page, batched per job so a chatty test run can't flood the stream.
  interface LogBuffer {
    orgId: string;
    taskId: string;
    text: string;
    timer?: NodeJS.Timeout;
  }
  const logBuffers = new Map<string, Promise<LogBuffer | null>>();

  function bufferFor(jobId: string) {
    let b = logBuffers.get(jobId);
    if (!b) {
      b = deps.sys
        .select({ orgId: schema.builderJobs.orgId, taskId: schema.builderJobs.taskId })
        .from(schema.builderJobs)
        .where(eq(schema.builderJobs.id, jobId))
        .then(([job]) => (job?.taskId ? { orgId: job.orgId, taskId: job.taskId, text: '' } : null));
      logBuffers.set(jobId, b);
    }
    return b;
  }

  async function bufferLog(jobId: string, data: string) {
    const b = await bufferFor(jobId);
    if (!b) return;
    b.text += data;
    if (b.text.length >= LOG_EVENT_MAX_CHARS) await flushLog(jobId);
    else b.timer ??= setTimeout(() => void flushLog(jobId).catch((err) => deps.log.error({ err }, 'test.log flush failed')), LOG_EVENT_INTERVAL_MS);
  }

  async function flushLog(jobId: string, done = false) {
    const b = await logBuffers.get(jobId);
    if (done) logBuffers.delete(jobId);
    if (!b) return;
    clearTimeout(b.timer);
    b.timer = undefined;
    while (b.text) {
      const text = b.text.slice(0, LOG_EVENT_MAX_CHARS);
      b.text = b.text.slice(LOG_EVENT_MAX_CHARS);
      await emit(deps.redis, { type: 'test.log', orgId: b.orgId, topic: taskTopic(b.taskId), payload: { taskId: b.taskId, jobId, text } });
    }
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
        await presence(conn, true);
        send(conn, { type: 'hello', protocol: PROTOCOL_VERSION, builderId: conn.builderId, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
        // Anything queued while it was offline goes out now.
        if (!msg.runningJobId) await deps.jobs.dispatchFor(conn.builderId);
        return;
      }
      case 'heartbeat': {
        // Re-checked every heartbeat, so revoking a builder disconnects it within 20 s.
        const [row] = await deps.sys.update(builders).set({ lastSeenAt: new Date() }).where(eq(builders.id, conn.builderId)).returning({ revokedAt: builders.revokedAt });
        if (!row || row.revokedAt) return void conn.ws.close(4001, 'builder revoked');
        await markSeen(conn);
        return;
      }
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
        await bufferLog(msg.jobId, msg.data);
        return;
      }
      case 'job.result': {
        if ((await deps.cache.get(busyKey(conn.builderId))) !== msg.jobId) return;
        // The last lines go out before the result, so the page never shows a result without its log.
        await flushLog(msg.jobId, true);
        const entries = await deps.redis.lrange(logsKey(msg.jobId), 0, -1);
        const text = entries.map((e) => JSON.parse(e) as { step: string; data: string }).map((e) => e.data).join('');
        const [job] = await deps.sys.select({ orgId: schema.builderJobs.orgId }).from(schema.builderJobs).where(eq(schema.builderJobs.id, msg.jobId));
        let logHash: string | null = null;
        if (job) logHash = await deps.blobs.put(text);
        await deps.jobs.finished(conn.builderId, msg, logHash);
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
      for (const b of logBuffers.values()) void b.then((x) => x && clearTimeout(x.timer));
      for (const c of conns.values()) c.ws.close(1001, 'gateway shutting down');
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** What the API's dispatcher (and the worker) use to reach a builder through whichever gateway holds it. */
export const redisBus = (redis: Redis) => publishBus((c, m) => redis.publish(c, m));
