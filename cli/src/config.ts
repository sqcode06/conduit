import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';

export interface Config {
  endpoint?: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

export interface State {
  lastLink?: string;
}

const paths = envPaths('conduit', { suffix: '' });
const CONFIG_FILE = join(paths.config, 'config.json');
const STATE_FILE = join(paths.config, 'state.json');

export const configPath = CONFIG_FILE;

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// File config, then environment overrides (handy for CI / one-offs).
export function loadConfig(): Config {
  const file = readJsonFile<Config>(CONFIG_FILE) ?? {};
  return {
    endpoint: process.env.CONDUIT_ENDPOINT ?? file.endpoint,
    accessClientId: process.env.CONDUIT_ACCESS_CLIENT_ID ?? file.accessClientId,
    accessClientSecret: process.env.CONDUIT_ACCESS_CLIENT_SECRET ?? file.accessClientSecret,
  };
}

export function saveConfig(cfg: Config): void {
  mkdirSync(paths.config, { recursive: true, mode: 0o700 });
  // 0600 — the file holds an Access service-token secret.
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

export function loadState(): State {
  return readJsonFile<State>(STATE_FILE) ?? {};
}

export function saveState(state: State): void {
  mkdirSync(paths.config, { recursive: true, mode: 0o700 });
  // 0600 — lastLink is a capability URL containing a live download token.
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(STATE_FILE, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

export function setLastLink(url: string): void {
  const s = loadState();
  s.lastLink = url;
  saveState(s);
}
