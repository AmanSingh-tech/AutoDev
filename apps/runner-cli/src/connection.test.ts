import type { AddressInfo } from 'node:net';
import { HEARTBEAT_INTERVAL_MS, OFFLINE_AFTER_MS, type BuilderMessage } from '@autodev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { BuilderConnection } from './connection';
import { gitConfigFor } from './job-runner';

const servers: WebSocketServer[] = [];
const conns: BuilderConnection[] = [];
afterEach(() => {
  conns.splice(0).forEach((c) => c.stop());
  servers.splice(0).forEach((s) => s.close());
  vi.useRealTimers();
});

/** Counts what a builder sends to a stub gateway. Waits use real timers; only intervals are faked. */
function gateway() {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  const received: BuilderMessage[] = [];
  wss.on('connection', (ws) =>
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString()) as BuilderMessage)),
  );
  const count = (type: string) => received.filter((m) => m.type === type).length;
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out; got ${received.map((m) => m.type).join(',')}`);
  };
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, count, until };
}

describe('builder presence timing', () => {
  it('is a 20 s heartbeat, and offline after 60 s of silence', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(20_000);
    expect(OFFLINE_AFTER_MS).toBe(60_000);
  });

  it('sends a heartbeat every 20 seconds once connected, and none before', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const gw = gateway();
    const conn = new BuilderConnection({
      url: gw.url,
      token: 'adb_' + 't'.repeat(40),
      cliVersion: '0.1.0',
      dockerAvailable: false,
      onOffer: () => {},
      onCancel: () => {},
      runningJobId: () => null,
    });
    conns.push(conn);
    conn.start();
    await gw.until(() => gw.count('hello') === 1);

    vi.advanceTimersByTime(19_999);
    await new Promise((r) => setTimeout(r, 100));
    expect(gw.count('heartbeat')).toBe(0);

    vi.advanceTimersByTime(1);
    await gw.until(() => gw.count('heartbeat') === 1);

    vi.advanceTimersByTime(40_000);
    await gw.until(() => gw.count('heartbeat') === 3);
  });
});

describe('git settings', () => {
  it('turns on long paths for every git command on Windows only', () => {
    expect(gitConfigFor('win32')).toEqual(['core.longpaths=true']);
    expect(gitConfigFor('linux')).toEqual([]);
    expect(gitConfigFor('darwin')).toEqual([]);
  });
});
