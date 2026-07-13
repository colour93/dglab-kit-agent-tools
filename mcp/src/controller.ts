import {
  COYOTE_WAVEFORMS,
  DGLAB_SOCKET_STATE,
  DglabSocket,
  OVC_WAVEFORMS,
  V4Channel,
} from 'dglab-kit';
import QRCode from 'qrcode';

export const DEFAULT_RELAY = 'wss://ws.dungeon-lab.cn/';
export const DEFAULT_LIMITS = Object.freeze({
  delta: 5,
  intensity: 20,
  durationMs: 5_000,
});

export type SafetyLimits = {
  delta: number;
  intensity: number;
  durationMs: number;
};

export type ChannelName = 'A' | 'B';

type ChannelSlotState = {
  isMuted?: boolean;
  intensityMax?: number;
  comfortLimit?: { overheat?: boolean };
};

type DeviceState = {
  slotId: string;
  name: string;
  type: string;
  props?: {
    connectState?: string;
    channelAStatus?: number | boolean;
    channelBStatus?: number | boolean;
    [key: string]: unknown;
  };
  slotState?: {
    hasDevice?: boolean;
    channelA?: ChannelSlotState;
    channelB?: ChannelSlotState;
    [key: string]: unknown;
  };
};

type WaveformMap = Record<string, { raw: string[] }>;

export type TargetInput = {
  clientId?: string;
  slotId?: string;
  channel?: ChannelName;
};

type Target = {
  clientId: string;
  slotId: string;
  channel: ChannelName;
  device: DeviceState;
};

type Selection = {
  clientId: string;
  slotId: string;
  deviceType: string;
  deviceName: string;
  channel: ChannelName;
};

type PairingQr = {
  appSocketUrl: string;
  qrPayload: string;
  qrPngBase64: string;
  qrTerminal: string;
};

type SdkChannel = (typeof V4Channel)[keyof typeof V4Channel];

const CHANNELS: Readonly<Record<ChannelName, SdkChannel>> = Object.freeze({
  A: V4Channel.A,
  B: V4Channel.B,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateRelay(value: string): string {
  let relay;
  try {
    relay = new URL(value);
  } catch {
    throw new Error('relay must be a valid ws:// or wss:// URL');
  }
  if (!['ws:', 'wss:'].includes(relay.protocol)) {
    throw new Error('relay must use ws:// or wss://');
  }
  return relay.toString();
}

function pairingPayload(relayUrl: string, targetId: string) {
  const relay = new URL(relayUrl);
  relay.searchParams.set('tid', targetId);
  const appSocketUrl = relay.toString();
  return {
    appSocketUrl,
    qrPayload: `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appSocketUrl)}`,
  };
}

async function pairingQr(relayUrl: string, targetId: string): Promise<PairingQr> {
  const { appSocketUrl, qrPayload } = pairingPayload(relayUrl, targetId);
  const [dataUrl, qrTerminal] = await Promise.all([
    QRCode.toDataURL(qrPayload, { errorCorrectionLevel: 'M', margin: 2, width: 768 }),
    QRCode.toString(qrPayload, { type: 'terminal', errorCorrectionLevel: 'M', margin: 1, small: true }),
  ]);
  return {
    appSocketUrl,
    qrPayload,
    qrPngBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    qrTerminal,
  };
}

function finiteInteger(value: number, name: string, { min, max }: { min: number; max: number }): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function channelState(device: DeviceState, channel: ChannelName): ChannelSlotState {
  const key = channel === 'B' ? 'channelB' : 'channelA';
  return device.slotState?.[key] ?? {};
}

function channelHardwareStatus(device: DeviceState, channel: ChannelName): number | boolean | undefined {
  const key = channel === 'B' ? 'channelBStatus' : 'channelAStatus';
  return device.props?.[key];
}

function assertDeviceEligible(device: DeviceState, channel: ChannelName): void {
  if (device.slotState?.hasDevice === false) throw new Error('selected slot reports no device');
  if (device.props?.connectState === 'disconnected') throw new Error('selected device is disconnected');

  const state = channelState(device, channel);
  if (state.isMuted === true) throw new Error('selected channel is muted');
  if (state.comfortLimit?.overheat === true) throw new Error('selected channel is overheated');

  const status = channelHardwareStatus(device, channel);
  if (status === 3) throw new Error('selected channel reports output damage');
  if (status === 4) throw new Error('selected channel is blocked');
  if (device.type === 'OVC_1' && status === false) {
    throw new Error('selected OVC channel reports no attached accessory');
  }
}

function effectiveIntensityMax(device: DeviceState, channel: ChannelName, configuredMax: number): number {
  const reported = channelState(device, channel).intensityMax;
  return typeof reported === 'number' && Number.isFinite(reported)
    ? Math.min(configuredMax, reported)
    : configuredMax;
}

function waveformsFor(deviceType: string): WaveformMap | undefined {
  if (deviceType === 'COYOTE_020' || deviceType === 'COYOTE_030') {
    return COYOTE_WAVEFORMS as unknown as WaveformMap;
  }
  if (deviceType === 'OVC_1') return OVC_WAVEFORMS as unknown as WaveformMap;
  return undefined;
}

function publicDevice(device: DeviceState) {
  return {
    slotId: device.slotId,
    name: device.name,
    type: device.type,
    props: device.props ?? {},
    slotState: device.slotState ?? {},
    waveforms: Object.keys(waveformsFor(device.type) ?? {}),
  };
}

export class DglabController {
  readonly defaultRelay: string;
  readonly limits: SafetyLimits;
  relay: string;
  advertisedRelay: string;
  socket: DglabSocket | null = null;
  targetId: string | null = null;
  qr: PairingQr | null = null;
  selection: Selection | null = null;
  readonly events: Array<{ at: string; message: string }> = [];
  readonly touchedTargets = new Map<string, Target>();
  readonly queues = new Map<string, Promise<unknown>>();
  readonly epochs = new Map<string, number>();

  constructor({ relay = DEFAULT_RELAY, limits = DEFAULT_LIMITS }: { relay?: string; limits?: SafetyLimits } = {}) {
    this.defaultRelay = validateRelay(relay);
    this.relay = this.defaultRelay;
    this.advertisedRelay = this.defaultRelay;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  record(message: string): void {
    this.events.push({ at: new Date().toISOString(), message });
    if (this.events.length > 30) this.events.shift();
  }

  bindSocket(socket: DglabSocket): void {
    const active = () => this.socket === socket;

    socket.on('state', (state, previous) => {
      if (!active()) return;
      this.record(`socket ${previous} -> ${state}`);
      if (state === DGLAB_SOCKET_STATE.Disconnected) this.invalidateSelection('socket disconnected');
    });
    socket.on('client-attached', async (clientId) => {
      if (!active()) return;
      this.record(`APP attached: ${clientId}`);
      try {
        await socket.requestDevices(clientId);
        await socket.ping(clientId);
        if (active()) this.record(`APP verified: ${clientId}`);
      } catch (error) {
        if (active()) this.record(`APP verification failed: ${errorMessage(error)}`);
      }
    });
    socket.on('client-disconnected', (clientId) => {
      if (!active()) return;
      this.record(`APP disconnected: ${clientId}`);
      if (this.selection?.clientId === clientId) this.invalidateSelection('selected APP disconnected');
    });
    socket.on('devices', (_devices, clientId) => {
      if (active()) this.ensureSelectionStillExists(clientId);
    });
    socket.on('device', (_device, clientId) => {
      if (active()) this.ensureSelectionStillExists(clientId);
    });
    socket.on('close', (event) => {
      if (!active()) return;
      this.record(`relay closed: ${event.code} ${event.reason || ''}`.trim());
      this.targetId = null;
      this.qr = null;
      this.invalidateSelection('relay closed');
    });
    socket.on('error', (error) => {
      if (active()) this.record(`socket error: ${errorMessage(error)}`);
    });
  }

  async connect(relayInput?: string, advertisedRelayInput?: string) {
    const relay = validateRelay(relayInput ?? this.relay ?? this.defaultRelay);
    const advertisedRelay = validateRelay(advertisedRelayInput ?? relay);
    if (this.targetId && this.qr && this.socket && relay === this.relay) {
      if (advertisedRelay !== this.advertisedRelay) {
        this.advertisedRelay = advertisedRelay;
        this.qr = await pairingQr(advertisedRelay, this.targetId);
      }
      return { reused: true, relay, advertisedRelay, targetId: this.targetId, ...this.qr };
    }
    if (this.socket) await this.disconnect('reconnect');

    this.relay = relay;
    this.advertisedRelay = advertisedRelay;
    const socket = new DglabSocket({ url: relay });
    this.socket = socket;
    this.bindSocket(socket);

    try {
      const { targetId } = await socket.connect();
      if (!targetId || socket.state !== DGLAB_SOCKET_STATE.WaitingForPeer) {
        throw new Error('V4 relay hello did not complete');
      }
      if (this.socket !== socket) throw new Error('connection was replaced before pairing completed');

      this.targetId = targetId;
      this.qr = await pairingQr(advertisedRelay, targetId);
      this.record(`relay connected; targetId=${targetId}`);
      return { reused: false, relay, advertisedRelay, targetId, ...this.qr };
    } catch (error) {
      if (this.socket === socket) {
        socket.destroy(1011, 'connect_failed');
        this.socket = null;
        this.targetId = null;
        this.qr = null;
      }
      throw error;
    }
  }

  clients() {
    if (!this.socket) return [];
    return this.socket.clients.map((client) => ({
      clientId: client.clientId,
      devices: client.devices.map((device) => publicDevice(device as unknown as DeviceState)),
    }));
  }

  status() {
    return {
      protocol: 'v4',
      transport: 'stdio MCP + WebSocket relay',
      relay: this.relay,
      advertisedRelay: this.advertisedRelay,
      socketState: this.socket?.state ?? DGLAB_SOCKET_STATE.Idle,
      targetId: this.targetId,
      clients: this.clients(),
      selection: this.selection,
      limits: this.limits,
      events: this.events,
    };
  }

  invalidateSelection(reason: string): void {
    if (this.selection) this.record(`selection cleared: ${reason}`);
    this.selection = null;
  }

  ensureSelectionStillExists(clientId: string): void {
    if (!this.selection || this.selection.clientId !== clientId) return;
    const device = this.socket?.getClient(clientId)?.getDevice(this.selection.slotId);
    if (!device) this.invalidateSelection('selected device disappeared');
  }

  resolveTarget(input: TargetInput = {}, { allowUnavailable = false }: { allowUnavailable?: boolean } = {}): Target {
    const hasExplicitTarget = input.clientId !== undefined || input.slotId !== undefined || input.channel !== undefined;
    const source = hasExplicitTarget ? input : this.selection;
    if (!source?.clientId || !source?.slotId || !source?.channel) {
      throw new Error('no active target; select one or provide clientId, slotId, and channel');
    }
    const channel = String(source.channel).toUpperCase() as ChannelName;
    if (!(channel in CHANNELS)) throw new Error('channel must be A or B');
    const client = this.socket?.getClient(source.clientId);
    if (!client) throw new Error('target APP is not attached');
    const sdkDevice = client.getDevice(source.slotId);
    if (!sdkDevice) throw new Error('target device is not available');
    const device = sdkDevice as unknown as DeviceState;
    if (!allowUnavailable) assertDeviceEligible(device, channel);
    return { clientId: source.clientId, slotId: source.slotId, channel, device };
  }

  requireSocket(): DglabSocket {
    if (!this.socket) throw new Error('controller is not connected');
    return this.socket;
  }

  select(input: TargetInput) {
    const target = this.resolveTarget(input);
    if (target.device.type === 'BMTR_1') {
      throw new Error('BMTR_1 is discoverable but does not support these control operations');
    }
    this.selection = {
      clientId: target.clientId,
      slotId: target.slotId,
      deviceType: target.device.type,
      deviceName: target.device.name,
      channel: target.channel,
    };
    const summary = this.summary(target, 'selected');
    this.record(summary);
    return { summary, selection: this.selection };
  }

  targetKey(target: Target): string {
    return `${target.clientId}:${target.slotId}:${target.channel}`;
  }

  summary(target: Target, command: string): string {
    return `APP ${target.clientId} / ${target.device.name} (${target.device.type}) / ${target.slotId} / channel ${target.channel} / ${command}`;
  }

  enqueue<T>(target: Target, operation: () => Promise<T>): Promise<T> {
    const key = this.targetKey(target);
    const epoch = this.epochs.get(key) ?? 0;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      if ((this.epochs.get(key) ?? 0) !== epoch) {
        throw new Error('command cancelled by a newer stop or disconnect request');
      }
      return operation();
    });
    this.queues.set(key, queued);
    queued.finally(() => {
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }).catch(() => undefined);
    return queued;
  }

  cancelQueued(target: Target): void {
    const key = this.targetKey(target);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
  }

  async increase(delta: number) {
    return this.relative('increase', delta);
  }

  async decrease(delta: number) {
    return this.relative('decrease', delta);
  }

  async relative(kind: 'increase' | 'decrease', value: number) {
    const target = this.resolveTarget();
    const socket = this.requireSocket();
    const delta = finiteInteger(value, 'delta', { min: 1, max: this.limits.delta });
    const channel = CHANNELS[target.channel];
    const summary = this.summary(target, `${kind} ${delta}`);
    this.touchedTargets.set(this.targetKey(target), target);
    this.record(`queued: ${summary}`);
    const result = await this.enqueue(target, () => kind === 'increase'
      ? socket.addIntensity(target.clientId, target.slotId, channel, delta, { immediate: true })
      : socket.reduceStrength(target.clientId, target.slotId, channel, delta, { immediate: true }));
    this.record(`finished: ${summary}`);
    return { summary, result };
  }

  async temporary(intensityInput: number, durationInput: number) {
    const target = this.resolveTarget();
    const socket = this.requireSocket();
    const max = effectiveIntensityMax(target.device, target.channel, this.limits.intensity);
    const intensity = finiteInteger(intensityInput, 'intensity', { min: 0, max });
    const durationMs = finiteInteger(durationInput, 'durationMs', { min: 0, max: this.limits.durationMs });
    const summary = this.summary(target, `temporary intensity ${intensity} for ${durationMs}ms`);
    this.touchedTargets.set(this.targetKey(target), target);
    this.record(`queued: ${summary}`);
    const result = await this.enqueue(target, () => socket.setTempIntensity(
      target.clientId,
      target.slotId,
      CHANNELS[target.channel],
      intensity,
      durationMs,
      { immediate: true },
    ));
    this.record(`finished: ${summary}`);
    return { summary, result };
  }

  async waveform(nameInput: string, durationInput: number) {
    const target = this.resolveTarget();
    const socket = this.requireSocket();
    const waveforms = waveformsFor(target.device.type);
    if (!waveforms) throw new Error(`device type ${target.device.type} has no compatible waveform set`);
    const name = String(nameInput).toUpperCase();
    const waveform = waveforms[name];
    if (!waveform) throw new Error(`unknown or incompatible waveform: ${nameInput}`);
    const durationMs = finiteInteger(durationInput, 'durationMs', { min: 0, max: this.limits.durationMs });
    const summary = this.summary(target, `waveform ${name} for ${durationMs}ms`);
    this.touchedTargets.set(this.targetKey(target), target);
    this.record(`queued: ${summary}`);
    const result = await this.enqueue(target, () => socket.sendPulse(
      target.clientId,
      target.slotId,
      CHANNELS[target.channel],
      durationMs,
      waveform.raw,
      { immediate: true },
    ));
    this.record(`finished: ${summary}`);
    return { summary, result };
  }

  async stop(input: TargetInput = {}) {
    const target = this.resolveTarget(input, { allowUnavailable: true });
    const socket = this.requireSocket();
    this.cancelQueued(target);
    const summary = this.summary(target, 'stop/clear');
    this.record(`priority: ${summary}`);
    const result = await socket.clearOperate(target.clientId, {
      slotId: target.slotId,
      channel: CHANNELS[target.channel],
    });
    this.touchedTargets.delete(this.targetKey(target));
    this.record(`finished: ${summary}`);
    return { summary, result };
  }

  async disconnect(reason = 'mcp_disconnect') {
    const socket = this.socket;
    if (!socket) return { summary: 'already disconnected' };

    const targets = [...this.touchedTargets.values()];
    for (const target of targets) this.cancelQueued(target);
    for (const target of targets) {
      if (!socket.getClient(target.clientId)) continue;
      try {
        await socket.clearOperate(target.clientId, {
          slotId: target.slotId,
          channel: CHANNELS[target.channel],
        });
      } catch (error) {
        this.record(`disconnect clear failed: ${errorMessage(error)}`);
      }
    }

    this.touchedTargets.clear();
    this.invalidateSelection('disconnect');
    this.targetId = null;
    this.qr = null;
    this.socket = null;
    socket.destroy(1000, reason);
    this.record('controller disconnected');
    return { summary: 'cleared touched channels and disconnected the controller' };
  }
}
