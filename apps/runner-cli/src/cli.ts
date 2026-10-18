import { resolve } from 'node:path';
import Docker from 'dockerode';
import { simpleGit } from 'simple-git';
import { Builder } from './builder';
import { DockerExecutor, ShellExecutor } from './executors';
import { sameRepo } from './job-runner';
import { cacheDir, clearSettings, loadSettings, saveSettings, settingsPath } from './settings';

const VERSION = '0.1.0';
const DEFAULT_API = process.env.AUTODEV_API_URL ?? 'http://localhost:4000';

const HELP = `autodev-runner ${VERSION}: runs AutoDev test jobs on this machine

  autodev login [--api URL] [--name NAME]   Pair this machine (approve the code in the dashboard)
  autodev start [--no-docker]                Connect and run jobs automatically
  autodev bind [PATH]                        Reuse an existing clone for its repo (warm caches)
  autodev status                             Show this builder's pairing
  autodev logout                             Forget this machine's builder token

Jobs only run commands from the base branch's .autodev.yml, in Docker by default, inside a
temporary git worktree that is deleted afterwards. No inbound ports are opened.`;

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function post<T>(url: string, body: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function login(args: string[]) {
  const api = (flag(args, '--api') ?? DEFAULT_API).replace(/\/$/, '');
  const name = flag(args, '--name') ?? `${process.env.USER ?? 'dev'}'s ${process.platform}`;
  const start = await post<{ deviceCode: string; userCode: string; verificationUriComplete: string; interval: number; expiresIn: number }>(`${api}/builder/pair/start`, { name });
  if (start.status !== 200) throw new Error(`Could not start pairing (HTTP ${start.status})`);
  console.log(`\nOpen ${start.body.verificationUriComplete}\nand confirm the code:  ${start.body.userCode}\n`);
  const until = Date.now() + start.body.expiresIn * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, start.body.interval * 1000));
    const poll = await post<{ status: string; token?: string; builderId?: string; orgSlug?: string; gatewayUrl?: string }>(`${api}/builder/pair/poll`, { deviceCode: start.body.deviceCode });
    if (poll.body.status === 'approved') {
      saveSettings({ apiUrl: api, gatewayUrl: poll.body.gatewayUrl!, builderId: poll.body.builderId!, orgSlug: poll.body.orgSlug!, token: poll.body.token! });
      console.log(`Paired with ${poll.body.orgSlug}. Saved to ${settingsPath()}.\nRun \`autodev start\` to begin taking jobs.`);
      return;
    }
    if (poll.status === 404) break;
  }
  throw new Error('The code expired before it was confirmed. Run `autodev login` again.');
}

async function bind(args: string[]) {
  const s = requireSettings();
  const path = resolve(args[0] ?? '.');
  const remote = (await simpleGit(path).raw(['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (!m || !sameRepo(remote, m[1]!)) throw new Error(`${path} has no GitHub origin remote`);
  const res = await post<{ repoId?: string; confirmed?: boolean; error?: string }>(`${s.apiUrl}/builder/bindings`, { repoFullName: m[1], localPath: path }, s.token);
  if (res.status !== 200) throw new Error(res.body.error ?? `HTTP ${res.status}`);
  console.log(`Bound ${m[1]} → ${path}.${res.body.confirmed ? '' : ' Confirm its first run in the dashboard when a job arrives.'}`);
}

async function start(args: string[]) {
  const s = requireSettings();
  let dockerExecutor: ((image: string) => DockerExecutor) | null = null;
  if (!args.includes('--no-docker')) {
    const docker = new Docker();
    try {
      await docker.ping();
      dockerExecutor = (image) => new DockerExecutor(docker, image);
    } catch {
      console.warn('Docker is not reachable. Docker jobs will be rejected until it is running (or start with --no-docker).');
    }
  } else {
    console.warn('Running without Docker: test commands run directly on this machine.');
  }
  const builder = new Builder({ gatewayUrl: s.gatewayUrl, token: s.token, cliVersion: VERSION, cacheDir: cacheDir(), dockerExecutor, shellExecutor: new ShellExecutor(), log: (l) => console.log(`[${new Date().toLocaleTimeString()}] ${l}`) });
  builder.start();
  const stop = () => {
    console.log('Stopping…');
    builder.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function requireSettings() {
  const s = loadSettings();
  if (!s) throw new Error('This machine is not paired yet. Run `autodev login` first.');
  return s;
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'login':
      return login(args);
    case 'start':
      return start(args);
    case 'bind':
      return bind(args);
    case 'status': {
      const s = loadSettings();
      return console.log(s ? `Paired as builder ${s.builderId} in ${s.orgSlug} (${s.apiUrl}).` : 'Not paired. Run `autodev login`.');
    }
    case 'logout':
      clearSettings();
      return console.log('Forgot this builder. Revoke it in the dashboard to invalidate the token too.');
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      return console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`autodev: ${e.message}`);
  process.exit(1);
});
