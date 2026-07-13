import type { Server, ServerWebSocket } from 'bun';

type WsData = { tid?: string };
type JsonObject = Record<string, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type MessageFrame = { type: 'message'; clientId?: string; data?: unknown };

export type V4RelayOptions = {
  bindHost: string;
  port: number;
  prefix?: string;
  heartbeatMs?: number;
  wsPingMs?: number;
  maxMissedPongs?: number;
  idleTimeoutMs?: number;
  maxPayloadBytes?: number;
  log?: (level: LogLevel, message: string) => void;
};

export type V4RelayHandle = {
  bindHost: string;
  port: number;
  prefix: string;
  stop: () => Promise<void>;
};

const isObject = (value: unknown): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isMessageFrame = (value: unknown): value is MessageFrame => (
  isObject(value) && value.type === 'message'
);

class RelayState {
  readonly sockets = new Set<ServerWebSocket<WsData>>();
  readonly ids = new Map<ServerWebSocket<WsData>, string>();
  readonly controllers = new Map<string, ServerWebSocket<WsData>>();
  readonly clientsByController = new Map<ServerWebSocket<WsData>, Map<string, ServerWebSocket<WsData>>>();
  readonly controllerByClient = new Map<ServerWebSocket<WsData>, ServerWebSocket<WsData>>();
  readonly idleTimers = new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>();
  readonly missedPongs = new Map<ServerWebSocket<WsData>, number>();
  readonly options: Required<Omit<V4RelayOptions, 'log'>>;
  readonly log: NonNullable<V4RelayOptions['log']>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  wsPingTimer?: ReturnType<typeof setInterval>;

  constructor(options: V4RelayOptions) {
    this.options = {
      bindHost: options.bindHost,
      port: options.port,
      prefix: normalizePrefix(options.prefix),
      heartbeatMs: options.heartbeatMs ?? 30_000,
      wsPingMs: options.wsPingMs ?? 10_000,
      maxMissedPongs: options.maxMissedPongs ?? 3,
      idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
      maxPayloadBytes: options.maxPayloadBytes ?? 1024 * 1024,
    };
    this.log = options.log ?? (() => undefined);
  }

  startTimers(): void {
    this.heartbeatTimer = setInterval(() => {
      const payload = JSON.stringify({ type: 'heartbeat' });
      for (const socket of this.sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      }
    }, this.options.heartbeatMs);
    this.wsPingTimer = setInterval(() => this.pingSockets(), this.options.wsPingMs);
  }

  stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.wsPingTimer) clearInterval(this.wsPingTimer);
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  send(socket: ServerWebSocket<WsData>, value: JsonObject): void {
    socket.send(JSON.stringify(value));
  }

  socketId(socket: ServerWebSocket<WsData>): string {
    return this.ids.get(socket) ?? '-';
  }

  onOpen(socket: ServerWebSocket<WsData>): void {
    const clientId = crypto.randomUUID().replaceAll('-', '');
    this.sockets.add(socket);
    this.ids.set(socket, clientId);
    this.missedPongs.set(socket, 0);
    this.send(socket, { type: 'hello', clientId });

    if (socket.data.tid) this.attachClient(socket, clientId, socket.data.tid);
    else this.attachController(socket, clientId);
  }

  onMessage(socket: ServerWebSocket<WsData>, raw: string | Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      this.log('warn', `invalid JSON from ${this.socketId(socket)}`);
      return;
    }
    if (isObject(value) && value.type === 'ping') {
      this.send(socket, { type: 'pong', ts: Date.now() });
      return;
    }
    if (isObject(value) && value.type === 'pong') return;
    if (!isMessageFrame(value)) return;

    const sourceId = this.ids.get(socket);
    if (!sourceId) return;
    if (this.controllers.has(sourceId)) {
      if (typeof value.clientId !== 'string') {
        this.send(socket, { type: 'error', code: 'bad_request', message: 'message.clientId is required' });
        return;
      }
      const client = this.clientsByController.get(socket)?.get(value.clientId);
      if (!client || client.readyState !== WebSocket.OPEN) {
        this.send(socket, { type: 'error', code: 'client_not_found', clientId: value.clientId });
        return;
      }
      this.send(client, { type: 'message', data: value.data });
      return;
    }

    const controller = this.controllerByClient.get(socket);
    if (!controller || controller.readyState !== WebSocket.OPEN) return;
    this.send(controller, { type: 'message', clientId: sourceId, data: value.data });
  }

  onPong(socket: ServerWebSocket<WsData>): void {
    this.missedPongs.set(socket, 0);
  }

  onClose(socket: ServerWebSocket<WsData>): void {
    this.sockets.delete(socket);
    this.missedPongs.delete(socket);
    const clientId = this.ids.get(socket);
    this.ids.delete(socket);
    if (!clientId) return;

    if (this.controllers.delete(clientId)) {
      this.cancelIdle(socket);
      const clients = this.clientsByController.get(socket);
      this.clientsByController.delete(socket);
      for (const client of clients?.values() ?? []) {
        this.controllerByClient.delete(client);
        if (client.readyState === WebSocket.OPEN) client.close(4000, 'controller_disconnected');
      }
      return;
    }

    const controller = this.controllerByClient.get(socket);
    if (!controller) return;
    this.controllerByClient.delete(socket);
    const clients = this.clientsByController.get(controller);
    clients?.delete(clientId);
    if (controller.readyState === WebSocket.OPEN) {
      this.send(controller, { type: 'client_disconnected', clientId });
      if (!clients?.size) this.startIdle(controller);
    }
  }

  attachController(socket: ServerWebSocket<WsData>, clientId: string): void {
    this.controllers.set(clientId, socket);
    this.clientsByController.set(socket, new Map());
    this.startIdle(socket);
  }

  attachClient(socket: ServerWebSocket<WsData>, clientId: string, targetId: string): void {
    const controller = this.controllers.get(targetId);
    if (!controller || controller.readyState !== WebSocket.OPEN) {
      this.send(socket, { type: 'error', code: 'controller_not_found' });
      socket.close(4001, 'controller_not_found');
      return;
    }
    this.clientsByController.get(controller)?.set(clientId, socket);
    this.controllerByClient.set(socket, controller);
    this.cancelIdle(controller);
    this.send(socket, { type: 'controller_attached', clientId: targetId });
    this.send(controller, { type: 'client_attached', clientId });
  }

  startIdle(controller: ServerWebSocket<WsData>): void {
    this.cancelIdle(controller);
    const timer = setTimeout(() => {
      this.idleTimers.delete(controller);
      if (controller.readyState === WebSocket.OPEN) {
        this.send(controller, { type: 'idle_timeout' });
        controller.close(4002, 'idle_timeout');
      }
    }, this.options.idleTimeoutMs);
    this.idleTimers.set(controller, timer);
  }

  cancelIdle(controller: ServerWebSocket<WsData>): void {
    const timer = this.idleTimers.get(controller);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(controller);
  }

  pingSockets(): void {
    for (const socket of this.sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const missed = this.missedPongs.get(socket) ?? 0;
      if (missed >= this.options.maxMissedPongs) {
        socket.terminate();
        continue;
      }
      this.missedPongs.set(socket, missed + 1);
      socket.ping();
    }
  }

  fetch(request: Request, server: Server<WsData>): Response | undefined {
    const url = new URL(request.url);
    if (url.pathname !== this.options.prefix) {
      return new Response('Not Found', { status: 404 });
    }
    const tid = url.searchParams.get('tid') ?? url.searchParams.get('targetId') ?? undefined;
    if (server.upgrade(request, { data: { tid } })) return;
    return new Response('WebSocket upgrade required', { status: 426 });
  }
}

function normalizePrefix(value = '/'): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, '') : prefixed;
}

export function startV4Relay(options: V4RelayOptions): V4RelayHandle {
  if (typeof Bun === 'undefined') throw new Error('embedded V4 relay requires the Bun runtime');
  const state = new RelayState(options);
  const server = Bun.serve<WsData>({
    hostname: options.bindHost,
    port: options.port,
    maxRequestBodySize: options.maxPayloadBytes ?? 1024 * 1024,
    fetch: (request, bunServer) => state.fetch(request, bunServer),
    websocket: {
      data: {} as WsData,
      maxPayloadLength: options.maxPayloadBytes ?? 1024 * 1024,
      open: (socket) => state.onOpen(socket),
      message: (socket, message) => state.onMessage(socket, message),
      pong: (socket) => state.onPong(socket),
      close: (socket) => state.onClose(socket),
    },
  });
  state.startTimers();
  state.log('info', `embedded V4 relay listening on ${options.bindHost}:${server.port}${state.options.prefix}`);
  return {
    bindHost: options.bindHost,
    port: server.port,
    prefix: state.options.prefix,
    stop: async () => {
      state.stopTimers();
      await server.stop(true);
    },
  };
}
