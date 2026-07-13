import type { Server, ServerWebSocket } from 'bun';

type WsData = { tid?: string };
type JsonObject = Record<string, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type MessageFrame = { type: 'message'; clientId?: string; data?: unknown };
type RpcRequest = { t: 'req'; reqId: string; m: string };
type RpcResponse = { t: 'resp'; reqId: string; result?: unknown; error?: string };

type PendingRequest = {
  controller: ServerWebSocket<WsData>;
  clientId: string;
  timer: ReturnType<typeof setTimeout>;
  finish: (status: number, payload: unknown) => void;
};

export type V4RelayOptions = {
  bindHost: string;
  port: number;
  heartbeatMs?: number;
  wsPingMs?: number;
  maxMissedPongs?: number;
  idleTimeoutMs?: number;
  httpTimeoutMs?: number;
  messagePaths?: string[];
  maxPayloadBytes?: number;
  corsOrigin?: string;
  log?: (level: LogLevel, message: string) => void;
};

export type V4RelayHandle = {
  bindHost: string;
  port: number;
  stop: () => Promise<void>;
};

const isObject = (value: unknown): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isMessageFrame = (value: unknown): value is MessageFrame => (
  isObject(value) && value.type === 'message'
);

const isRpcRequest = (value: unknown): value is RpcRequest => (
  isObject(value)
  && value.t === 'req'
  && typeof value.reqId === 'string'
  && value.reqId.length > 0
  && typeof value.m === 'string'
  && value.m.length > 0
);

const isRpcResponse = (value: unknown): value is RpcResponse => (
  isObject(value)
  && value.t === 'resp'
  && typeof value.reqId === 'string'
  && ('result' in value || typeof value.error === 'string')
);

class RelayState {
  readonly sockets = new Set<ServerWebSocket<WsData>>();
  readonly ids = new Map<ServerWebSocket<WsData>, string>();
  readonly controllers = new Map<string, ServerWebSocket<WsData>>();
  readonly secrets = new Map<string, ServerWebSocket<WsData>>();
  readonly secretByController = new Map<ServerWebSocket<WsData>, string>();
  readonly clientsByController = new Map<ServerWebSocket<WsData>, Map<string, ServerWebSocket<WsData>>>();
  readonly controllerByClient = new Map<ServerWebSocket<WsData>, ServerWebSocket<WsData>>();
  readonly idleTimers = new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>();
  readonly missedPongs = new Map<ServerWebSocket<WsData>, number>();
  readonly pending = new Map<string, PendingRequest>();
  readonly options: Required<Omit<V4RelayOptions, 'log'>>;
  readonly log: NonNullable<V4RelayOptions['log']>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  wsPingTimer?: ReturnType<typeof setInterval>;

  constructor(options: V4RelayOptions) {
    this.options = {
      bindHost: options.bindHost,
      port: options.port,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      wsPingMs: options.wsPingMs ?? 10_000,
      maxMissedPongs: options.maxMissedPongs ?? 3,
      idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
      httpTimeoutMs: options.httpTimeoutMs ?? 30_000,
      messagePaths: options.messagePaths ?? ['/message', '/v4/message'],
      maxPayloadBytes: options.maxPayloadBytes ?? 1024 * 1024,
      corsOrigin: options.corsOrigin ?? '*',
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
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.idleTimers.clear();
    this.pending.clear();
  }

  send(socket: ServerWebSocket<WsData>, value: JsonObject): void {
    socket.send(JSON.stringify(value));
  }

  socketId(socket: ServerWebSocket<WsData>): string {
    return this.ids.get(socket) ?? '-';
  }

  onOpen(socket: ServerWebSocket<WsData>): void {
    const clientId = crypto.randomUUID().replaceAll('-', '');
    const secret = crypto.randomUUID();
    this.sockets.add(socket);
    this.ids.set(socket, clientId);
    this.missedPongs.set(socket, 0);
    this.send(socket, { type: 'hello', clientId, apikey: secret, secret });

    if (socket.data.tid) this.attachClient(socket, clientId, socket.data.tid);
    else this.attachController(socket, clientId, secret);
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
    this.resolvePending(controller, sourceId, value.data);
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
      const secret = this.secretByController.get(socket);
      if (secret) this.secrets.delete(secret);
      this.secretByController.delete(socket);
      this.cancelIdle(socket);
      this.rejectPending(socket, undefined, 'controller_disconnected');
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
    this.rejectPending(controller, clientId, 'client_disconnected');
    if (controller.readyState === WebSocket.OPEN) {
      this.send(controller, { type: 'client_disconnected', clientId });
      if (!clients?.size) this.startIdle(controller);
    }
  }

  attachController(socket: ServerWebSocket<WsData>, clientId: string, secret: string): void {
    this.controllers.set(clientId, socket);
    this.secrets.set(secret, socket);
    this.secretByController.set(socket, secret);
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

  requestKey(controller: ServerWebSocket<WsData>, clientId: string, reqId: string): string {
    return `${this.socketId(controller)}\u0000${clientId}\u0000${reqId}`;
  }

  waitForRpc(controller: ServerWebSocket<WsData>, clientId: string, reqId: string): Promise<Response> {
    const key = this.requestKey(controller, clientId, reqId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(this.json(504, { ok: false, error: 'request_timeout' }));
      }, this.options.httpTimeoutMs);
      this.pending.set(key, {
        controller,
        clientId,
        timer,
        finish: (status, payload) => {
          clearTimeout(timer);
          this.pending.delete(key);
          resolve(this.json(status, payload));
        },
      });
    });
  }

  resolvePending(controller: ServerWebSocket<WsData>, clientId: string, value: unknown): void {
    if (!isRpcResponse(value)) return;
    const entry = this.pending.get(this.requestKey(controller, clientId, value.reqId));
    if (!entry) return;
    entry.finish(200, typeof value.error === 'string'
      ? { ok: false, error: value.error }
      : { ok: true, result: value.result });
  }

  rejectPending(controller: ServerWebSocket<WsData>, clientId: string | undefined, error: string): void {
    for (const entry of this.pending.values()) {
      if (entry.controller !== controller || (clientId && entry.clientId !== clientId)) continue;
      entry.finish(504, { ok: false, error });
    }
  }

  json(status: number, payload?: unknown): Response {
    const headers: Record<string, string> = {
      'access-control-allow-origin': this.options.corsOrigin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, apikey, x-apikey',
    };
    if (payload === undefined) return new Response(null, { status, headers });
    headers['content-type'] = 'application/json; charset=utf-8';
    return new Response(JSON.stringify(payload), { status, headers });
  }

  async fetch(request: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(request.url);
    const tid = url.searchParams.get('tid') ?? url.searchParams.get('targetId') ?? undefined;
    if (server.upgrade(request, { data: { tid } })) return;
    if (!this.options.messagePaths.includes(url.pathname)) return this.json(404, { ok: false, error: 'not_found' });
    if (request.method === 'OPTIONS') return this.json(204);
    if (request.method !== 'POST') return this.json(405, { ok: false, error: 'method_not_allowed' });

    const apiKey = request.headers.get('apikey') ?? request.headers.get('x-apikey');
    const controller = apiKey ? this.secrets.get(apiKey) : undefined;
    if (!controller || controller.readyState !== WebSocket.OPEN) {
      return this.json(401, { ok: false, error: 'unauthorized' });
    }
    if (Number(request.headers.get('content-length') ?? 0) > this.options.maxPayloadBytes) {
      return this.json(413, { ok: false, error: 'body_too_large' });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return this.json(400, { ok: false, error: 'invalid_json' });
    }
    if (!isMessageFrame(body) || typeof body.clientId !== 'string' || !isRpcRequest(body.data)) {
      return this.json(400, { ok: false, error: 'bad_request' });
    }
    const client = this.clientsByController.get(controller)?.get(body.clientId);
    if (!client || client.readyState !== WebSocket.OPEN) {
      return this.json(404, { ok: false, error: 'client_not_found' });
    }
    const key = this.requestKey(controller, body.clientId, body.data.reqId);
    if (this.pending.has(key)) return this.json(409, { ok: false, error: 'duplicate_request' });
    const response = this.waitForRpc(controller, body.clientId, body.data.reqId);
    this.send(client, { type: 'message', data: body.data });
    return response;
  }
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
  state.log('info', `embedded V4 relay listening on ${options.bindHost}:${server.port}`);
  return {
    bindHost: options.bindHost,
    port: server.port,
    stop: async () => {
      state.stopTimers();
      await server.stop(true);
    },
  };
}
