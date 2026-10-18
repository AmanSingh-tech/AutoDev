import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Settings {
  apiUrl: string;
  gatewayUrl: string;
  builderId: string;
  orgSlug: string;
  /** Bearer token for this builder. Stored with 0600 permissions. */
  token: string;
}

const base = () =>
  process.env.AUTODEV_HOME ??
  (process.platform === 'win32' ? join(process.env.APPDATA ?? homedir(), 'autodev') : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autodev'));

export const settingsPath = () => join(base(), 'builder.json');
export const cacheDir = () =>
  process.env.AUTODEV_CACHE ??
  (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? homedir(), 'autodev', 'cache') : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'autodev'));

export function loadSettings(): Settings | null {
  const p = settingsPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Settings;
}

export function saveSettings(s: Settings) {
  const p = settingsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(p, 0o600);
}

export function clearSettings() {
  rmSync(settingsPath(), { force: true });
}
