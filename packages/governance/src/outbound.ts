import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound requests to addresses an org admin typed in (SIEM endpoints, later Jira). Without a
 * guard, such a URL could reach the server's own network (metadata services, Postgres, Redis).
 * The check runs on the address the connection actually uses, so DNS tricks can't get around it.
 */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
  return PRIVATE.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export class OutboundUrlError extends Error {}

export interface OutboundOptions {
  /** Development and tests only: allow http:// and private addresses (e.g. a local mock). */
  allowPrivate?: boolean;
}

/** Checks the shape of a URL before it's saved (https, no credentials). The address is checked on every send. */
export function assertOutboundUrl(raw: string, opts: OutboundOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError('Not a valid URL');
  }
  if (url.protocol !== 'https:' && !(opts.allowPrivate && url.protocol === 'http:')) throw new OutboundUrlError('The URL must start with https://');
  if (url.username || url.password) throw new OutboundUrlError('Put credentials in the secret, not the URL');
  if (!opts.allowPrivate && isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, '')))
    throw new OutboundUrlError('The URL points at a private network address');
  return url;
}

/** A DNS lookup that refuses private addresses, used as the connection's resolver. */
function guardedLookup(hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(Object.assign(new OutboundUrlError(`${hostname} resolves to a private address`), { code: 'EPRIVATE' }), '');
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

export interface OutboundResponse {
  status: number;
  body: string;
}

/** POSTs `body` and returns the status and up to 4 KB of the response. Times out after `timeoutMs`. */
export function postOutbound(raw: string, body: string, headers: Record<string, string>, opts: OutboundOptions & { timeoutMs?: number } = {}): Promise<OutboundResponse> {
  const url = assertOutboundUrl(raw, opts);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'POST',
        headers: { 'content-length': Buffer.byteLength(body).toString(), ...headers },
        timeout: opts.timeoutMs ?? 15_000,
        ...(opts.allowPrivate ? {} : { lookup: guardedLookup as never }),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (text.length < 4096) text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text.slice(0, 4096) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
