import { networkInterfaces } from 'node:os';
import { randomInt } from 'node:crypto';
import { startV4Relay, type V4RelayHandle } from './v4-relay.ts';

export type EmbeddedRelayConfig = {
  bindHost?: string;
  port?: number;
  prefix?: string;
  controllerUrl?: string;
  advertisedUrl?: string;
  allowNetworkExposure?: boolean;
};

export type EmbeddedRelayDefaults = Required<Omit<EmbeddedRelayConfig, 'port' | 'controllerUrl' | 'advertisedUrl'>> & {
  port?: number;
  controllerUrl?: string;
  advertisedUrl?: string;
};

type RunningRelay = {
  handle: V4RelayHandle;
  bindHost: string;
  port: number;
  prefix: string;
  controllerUrl: string;
  advertisedUrl: string;
  networkExposed: boolean;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DYNAMIC_PORT_MIN = 49_152;
const DYNAMIC_PORT_MAX_EXCLUSIVE = 65_536;

function wsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid ws:// or wss:// URL`);
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`${name} must use ws:// or wss://`);
  }
  return url.toString();
}

function normalizePrefix(value = '/'): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, '') : prefixed;
}

function hostUrl(host: string, port: number, prefix: string): string {
  const formatted = host.includes(':') ? `[${host}]` : host;
  return `ws://${formatted}:${port}${prefix}`;
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('embedded relay port must be an integer from 1 to 65535');
  }
  return value;
}

export class EmbeddedRelayManager {
  readonly defaults: EmbeddedRelayDefaults;
  private running: RunningRelay | null = null;
  private suggestedPort: number | null = null;

  constructor(defaults: EmbeddedRelayDefaults) {
    this.defaults = defaults;
  }

  listAddresses(portInput?: number, prefixInput?: string) {
    const configuredPort = portInput ?? this.defaults.port;
    if (configuredPort !== undefined) this.suggestedPort = null;
    const port = configuredPort === undefined
      ? (this.suggestedPort ??= randomInt(DYNAMIC_PORT_MIN, DYNAMIC_PORT_MAX_EXCLUSIVE))
      : validPort(configuredPort);
    const prefix = normalizePrefix(prefixInput ?? this.defaults.prefix);
    const addresses = [{
      scope: 'loopback',
      interface: 'loopback',
      address: '127.0.0.1',
      advertisedUrl: hostUrl('127.0.0.1', port, prefix),
      reachableFromPhone: false,
    }];
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== 'IPv4') continue;
        addresses.push({
          scope: 'lan',
          interface: name,
          address: entry.address,
          advertisedUrl: hostUrl(entry.address, port, prefix),
          reachableFromPhone: true,
        });
      }
    }
    return { port, prefix, addresses };
  }

  status() {
    if (!this.running) return { running: false, runtime: process.versions.bun ? 'bun' : 'node' };
    const { bindHost, port, prefix, controllerUrl, advertisedUrl, networkExposed } = this.running;
    return {
      running: true,
      runtime: process.versions.bun ? 'bun' : 'node',
      bindHost,
      port,
      prefix,
      controllerUrl,
      advertisedUrl,
      networkExposed,
    };
  }

  async start(input: EmbeddedRelayConfig = {}) {
    if (!process.versions.bun) {
      throw new Error('embedded relay requires Bun; Node fallback supports remote relay mode only');
    }
    const bindHost = input.bindHost ?? this.defaults.bindHost;
    const configuredPort = input.port ?? this.defaults.port;
    const port = configuredPort === undefined
      ? (this.suggestedPort ?? randomInt(DYNAMIC_PORT_MIN, DYNAMIC_PORT_MAX_EXCLUSIVE))
      : validPort(configuredPort);
    this.suggestedPort = null;
    const prefix = normalizePrefix(input.prefix ?? this.defaults.prefix);
    const networkExposed = !isLoopback(bindHost);
    const allowed = input.allowNetworkExposure ?? this.defaults.allowNetworkExposure;
    if (networkExposed && !allowed) {
      throw new Error('binding a non-loopback address requires allowNetworkExposure=true');
    }

    const controllerHost = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
    const controllerUrl = wsUrl(
      input.controllerUrl ?? this.defaults.controllerUrl ?? hostUrl(controllerHost, port, prefix),
      'controllerUrl',
    );
    const advertisedInput = input.advertisedUrl ?? this.defaults.advertisedUrl;
    if (networkExposed && !advertisedInput) {
      throw new Error('advertisedUrl is required when the embedded relay is exposed beyond loopback');
    }
    const advertisedUrl = wsUrl(advertisedInput ?? controllerUrl, 'advertisedUrl');

    if (
      this.running
      && this.running.bindHost === bindHost
      && this.running.port === port
      && this.running.prefix === prefix
      && this.running.controllerUrl === controllerUrl
      && this.running.advertisedUrl === advertisedUrl
    ) {
      return { reused: true, ...this.status() };
    }
    await this.stop();
    const handle = startV4Relay({ bindHost, port, prefix });
    this.running = {
      handle,
      bindHost,
      port: handle.port,
      prefix: handle.prefix,
      controllerUrl,
      advertisedUrl,
      networkExposed,
    };
    return { reused: false, ...this.status() };
  }

  connectionUrls(): { controllerUrl: string; advertisedUrl: string } {
    if (!this.running) throw new Error('embedded relay is not running');
    return {
      controllerUrl: this.running.controllerUrl,
      advertisedUrl: this.running.advertisedUrl,
    };
  }

  async stop() {
    const running = this.running;
    if (!running) return { stopped: false, summary: 'embedded relay is already stopped' };
    this.running = null;
    await running.handle.stop();
    return { stopped: true, summary: 'embedded relay stopped' };
  }
}
