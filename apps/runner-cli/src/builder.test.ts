import type { AddressInfo } from 'node:net';
import type { BuilderMessage } from '@autodev/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { fixture, offer } from '../test/git-fixture';
import { Builder } from './builder';
import { ShellExecutor } from './executors';

/** A stub gateway that records what the builder sends. */
function stubGateway() {
  const wss = new WebSocketServer({ port: 0 });
  const received: BuilderMessage[] = [];
  const sockets: WebSocket[] = [];
  let authHeader = '';
  wss.on('connection', (ws, req) => {
    authHeader = req.headers.authorization ?? '';
    sockets.push(ws);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as BuilderMessage;
      received.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'hello', protocol: 1, builderId: '018f0000-0000-7000-8000-0000000000aa', heartbeatIntervalMs: 20000 }));
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const waitFor = async (pred: (m: BuilderMessage[]) => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (pred(received)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out; got ${received.map((m) => m.type).join(',')}`);
  };
  return { wss, url, received, sockets, waitFor, auth: () => authHeader };
}

const builders: Builder[] = [];
const servers: WebSocketServer[] = [];
afterEach(() => {
  builders.splice(0).forEach((b) => b.stop());
  servers.splice(0).forEach((s) => s.close());
});

function makeBuilder(url: string, cache: string, docker = false) {
  const logs: string[] = [];
  const b = new Builder({ gatewayUrl: url, token: 'adb_' + 't'.repeat(40), cliVersion: '0.1.0', cacheDir: cache, dockerExecutor: docker ? () => new ShellExecutor() : null, shellExecutor: new ShellExecutor(), log: (l) => logs.push(l) });
  builders.push(b);
  return { b, logs };
}

describe('Builder', () => {
  it('says hello with its token, accepts an offer, streams logs and reports the result', async () => {
    const gw = stubGateway();
    servers.push(gw.wss);
    const f = fixture();
    makeBuilder(gw.url, f.cache).b.start();
    await gw.waitFor((m) => m.some((x) => x.type === 'hello'));
    expect(gw.auth()).toBe(`Bearer adb_${'t'.repeat(40)}`);
    expect(gw.received[0]).toMatchObject({ type: 'hello', dockerAvailable: false, runningJobId: null });

    gw.sockets[0]!.send(JSON.stringify(offer(f)));
    await gw.waitFor((m) => m.some((x) => x.type === 'job.result'));
    const types = gw.received.map((m) => m.type);
    expect(types.indexOf('job.accept')).toBeLessThan(types.indexOf('log.chunk'));
    expect(types.lastIndexOf('log.chunk')).toBeLessThan(types.indexOf('job.result'));
    expect(gw.received.find((m) => m.type === 'job.result')).toMatchObject({ status: 'passed' });
  });

  it('rejects a second offer while busy, and Docker jobs when Docker is unavailable', async () => {
    const gw = stubGateway();
    servers.push(gw.wss);
    const f = fixture();
    makeBuilder(gw.url, f.cache).b.start();
    await gw.waitFor((m) => m.some((x) => x.type === 'hello'));
    const long = offer(f, { config: { test: ['sleep 2'], timeout_min: 1 } });
    gw.sockets[0]!.send(JSON.stringify(long));
    gw.sockets[0]!.send(JSON.stringify({ ...offer(f), jobId: '018f0000-0000-7000-8000-000000000002' }));
    gw.sockets[0]!.send(JSON.stringify({ ...offer(f), jobId: '018f0000-0000-7000-8000-000000000003', docker: true }));
    await gw.waitFor((m) => m.filter((x) => x.type === 'job.reject').length === 2);
    expect(gw.received.filter((m) => m.type === 'job.reject').map((m) => (m as { reason: string }).reason).sort()).toEqual(['busy', 'busy']);
  });

  it('rejects Docker jobs on a machine without Docker', async () => {
    const gw = stubGateway();
    servers.push(gw.wss);
    const f = fixture();
    makeBuilder(gw.url, f.cache).b.start();
    await gw.waitFor((m) => m.some((x) => x.type === 'hello'));
    gw.sockets[0]!.send(JSON.stringify(offer(f, { docker: true })));
    await gw.waitFor((m) => m.some((x) => x.type === 'job.reject'));
    expect(gw.received.find((m) => m.type === 'job.reject')).toMatchObject({ reason: 'docker_unavailable' });
  });

  it('stops a running job when the dashboard cancels it', async () => {
    const gw = stubGateway();
    servers.push(gw.wss);
    const f = fixture();
    makeBuilder(gw.url, f.cache).b.start();
    await gw.waitFor((m) => m.some((x) => x.type === 'hello'));
    const o = offer(f, { config: { test: ['sleep 30'], timeout_min: 1 } });
    gw.sockets[0]!.send(JSON.stringify(o));
    await gw.waitFor((m) => m.some((x) => x.type === 'job.accept'));
    gw.sockets[0]!.send(JSON.stringify({ type: 'job.cancel', jobId: o.jobId }));
    await gw.waitFor((m) => m.some((x) => x.type === 'job.result'));
    expect(gw.received.find((m) => m.type === 'job.result')).toMatchObject({ status: 'error', error: 'cancelled' });
  });

  it('reconnects after a drop, and gives up for good when revoked', async () => {
    const gw = stubGateway();
    servers.push(gw.wss);
    const f = fixture();
    const { logs, b } = makeBuilder(gw.url, f.cache);
    b.start();
    await gw.waitFor((m) => m.filter((x) => x.type === 'hello').length === 1);
    gw.sockets[0]!.terminate();
    await gw.waitFor((m) => m.filter((x) => x.type === 'hello').length === 2);
    gw.sockets[1]!.close(4001, 'builder revoked');
    await new Promise((r) => setTimeout(r, 1500));
    expect(gw.received.filter((x) => x.type === 'hello')).toHaveLength(2);
    expect(logs.some((l) => l.includes('revoked'))).toBe(true);
  });
});
