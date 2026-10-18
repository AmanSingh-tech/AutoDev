import { HEARTBEAT_INTERVAL_MS, parseGatewayMessage, PROTOCOL_VERSION, type BuilderMessage, type GatewayMessage, type JobOffer } from '@autodev/protocol';
import { WebSocket } from 'ws';

export interface ConnectionOptions {
  url: string;
  token: string;
  cliVersion: string;
  dockerAvailable: boolean;
  onOffer: (offer: JobOffer) => void;
  onCancel: (jobId: string) => void;
  onStatus?: (s: 'connecting' | 'online' | 'offline' | 'revoked', detail?: string) => void;
  runningJobId: () => string | null;
}

/**
 * The builder's single outbound WebSocket. Reconnects with exponential backoff (1 s → 30 s), says
 * hello, and sends a heartbeat every 20 s. A revoked builder stops trying.
 */
export class BuilderConnection {
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retry = 0;
  private stopped = false;

  constructor(private readonly opts: ConnectionOptions) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close(1000, 'builder stopping');
  }

  send(msg: BuilderMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect() {
    this.opts.onStatus?.('connecting');
    const ws = new WebSocket(this.opts.url, { headers: { authorization: `Bearer ${this.opts.token}` }, handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      this.send({ type: 'hello', protocol: PROTOCOL_VERSION, cliVersion: this.opts.cliVersion, os: process.platform, arch: process.arch, dockerAvailable: this.opts.dockerAvailable, runningJobId: this.opts.runningJobId() });
      this.heartbeat = setInterval(() => this.send({ type: 'heartbeat', ts: Date.now() }), HEARTBEAT_INTERVAL_MS);
    });
    ws.on('message', (raw) => {
      const msg = parseGatewayMessage(raw.toString());
      if (msg) this.handle(msg);
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        this.stopped = true;
        this.opts.onStatus?.('revoked', 'The gateway rejected this builder token. Run `autodev login` again.');
      }
    });
    ws.on('close', (code) => {
      this.clearHeartbeat();
      if (code === 4001) {
        this.stopped = true;
        this.opts.onStatus?.('revoked', 'This builder was revoked in the dashboard.');
      }
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.opts.onStatus?.('offline', `reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => !this.stopped && this.connect(), delay);
    });
    ws.on('error', () => {
      /* 'close' follows and handles the reconnect */
    });
  }

  private handle(msg: GatewayMessage) {
    if (msg.type === 'hello') this.opts.onStatus?.('online');
    else if (msg.type === 'job.offer') this.opts.onOffer(msg);
    else if (msg.type === 'job.cancel') this.opts.onCancel(msg.jobId);
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
