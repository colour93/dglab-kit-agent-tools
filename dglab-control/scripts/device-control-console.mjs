#!/usr/bin/env node
import { createServer } from 'node:http';
import process from 'node:process';
import {
  COYOTE_WAVEFORMS,
  DGLAB_SOCKET_STATE,
  DglabSocket,
  OVC_WAVEFORMS,
  V4Channel,
} from 'dglab-kit';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';

const DEFAULT_RELAY = 'wss://ws.dungeon-lab.cn/';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 47821;
const SAFETY_CEILINGS = Object.freeze({ delta: 5, intensity: 20, durationMs: 5_000 });
const CHANNELS = Object.freeze({ A: V4Channel.A, B: V4Channel.B });
const API_ENV = 'DGLAB_CONTROL_API';

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`DG-LAB single-file control console (V4)

Keep one controller session alive:
  bun device-control-console.mjs serve [--relay <ws-url>] [--port 47821] [--terminal-qr]

Control that session from another terminal or an agent:
  bun device-control-console.mjs status
  bun device-control-console.mjs select --client-id <id> --slot-id <id> --channel A
  bun device-control-console.mjs increase --delta 2
  bun device-control-console.mjs decrease --delta 2
  bun device-control-console.mjs temporary --intensity 10 --duration-ms 2000
  bun device-control-console.mjs waveform --name BUBBLE --duration-ms 2000
  bun device-control-console.mjs stop
  bun device-control-console.mjs zero
  bun device-control-console.mjs shutdown

Use --api <url> or ${API_ENV} to address a non-default local console.`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === 'terminal-qr') {
      result.terminalQr = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for --${name}`);
    result[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return result;
}

function integer(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateRelay(value) {
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

function pairingPayload(relayUrl, targetId) {
  const relay = new URL(relayUrl);
  relay.searchParams.set('tid', targetId);
  const appSocketUrl = relay.toString();
  return {
    appSocketUrl,
    qrPayload: `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appSocketUrl)}`,
  };
}

function deviceWaveforms(deviceType) {
  if (deviceType === 'COYOTE_020' || deviceType === 'COYOTE_030') return COYOTE_WAVEFORMS;
  if (deviceType === 'OVC_1') return OVC_WAVEFORMS;
  return undefined;
}

function publicDevice(device) {
  return {
    slotId: device.slotId,
    name: device.name,
    type: device.type,
    props: device.props ?? {},
    slotState: device.slotState ?? {},
  };
}

function channelState(device, channel) {
  const key = channel === 'B' ? 'channelB' : 'channelA';
  const candidates = [device.slotState?.[key], device.props?.[key]];
  return candidates.find((candidate) => candidate && typeof candidate === 'object') ?? {};
}

function assertDeviceEligible(device, channel) {
  if (device.slotState?.hasDevice === false) throw new Error('selected slot reports no device');
  if (device.props?.connectState === 'disconnected') throw new Error('selected device is disconnected');
  const state = channelState(device, channel);
  for (const flag of ['muted', 'overheated', 'damaged', 'blocked']) {
    if (state[flag] === true) throw new Error(`selected channel is ${flag}`);
  }
}

function effectiveIntensityMax(device, channel, configuredMax) {
  const reported = channelState(device, channel).intensityMax;
  if (Number.isFinite(reported)) return Math.min(configuredMax, reported);
  return configuredMax;
}

function htmlPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DG-LAB / LIVE CONTROL</title>
  <style>
    :root { --ink:#e7eadf; --muted:#899080; --panel:#141713; --line:#343a30; --acid:#b9ff38; --amber:#ffb000; --danger:#ff3b2f; --void:#090b09; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--void); font-family:"Avenir Next Condensed","DIN Condensed","Microsoft YaHei",sans-serif; min-height:100vh; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.18; background:repeating-linear-gradient(0deg,transparent 0 3px,#fff 4px); mix-blend-mode:overlay; }
    button,input,select { font:inherit; }
    .shell { max-width:1240px; margin:auto; padding:24px; }
    header { display:grid; grid-template-columns:1fr auto; gap:16px; align-items:end; border-bottom:1px solid var(--line); padding-bottom:18px; }
    .eyebrow,.label { color:var(--muted); text-transform:uppercase; letter-spacing:.18em; font-size:12px; }
    h1 { margin:4px 0 0; font-size:clamp(36px,6vw,76px); line-height:.85; letter-spacing:-.04em; font-weight:800; }
    .live { display:flex; align-items:center; gap:10px; color:var(--acid); letter-spacing:.12em; }
    .dot { width:10px; height:10px; border-radius:50%; background:currentColor; box-shadow:0 0 18px currentColor; animation:pulse 1.6s infinite; }
    @keyframes pulse { 50% { opacity:.35; transform:scale(.75); } }
    main { display:grid; grid-template-columns:minmax(280px,.78fr) minmax(0,1.7fr); gap:16px; margin-top:16px; }
    .stack { display:grid; gap:16px; align-content:start; }
    .panel { position:relative; background:var(--panel); border:1px solid var(--line); padding:18px; overflow:hidden; }
    .panel::after { content:attr(data-index); position:absolute; top:8px; right:12px; color:#3c4337; font:700 46px/1 monospace; }
    .panel h2 { margin:0 0 18px; font-size:18px; letter-spacing:.08em; text-transform:uppercase; }
    .qr-wrap { display:grid; place-items:center; min-height:260px; background:#f2f5e8; padding:12px; }
    .qr-wrap img { width:min(100%,260px); display:block; image-rendering:pixelated; }
    .mono { font-family:"IBM Plex Mono","SFMono-Regular",Consolas,monospace; font-size:12px; word-break:break-all; }
    .status-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:1px; background:var(--line); border:1px solid var(--line); margin-top:12px; }
    .metric { background:var(--panel); padding:12px; min-width:0; }
    .metric strong { display:block; margin-top:5px; color:var(--acid); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .field { display:grid; gap:7px; margin-bottom:13px; }
    select,input { width:100%; color:var(--ink); background:#0d100d; border:1px solid var(--line); padding:11px 12px; outline:none; }
    select:focus,input:focus { border-color:var(--acid); box-shadow:0 0 0 1px var(--acid); }
    .channels,.actions { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; }
    button { cursor:pointer; border:1px solid var(--line); background:#22271f; color:var(--ink); padding:12px 14px; text-transform:uppercase; letter-spacing:.08em; transition:.15s ease; }
    button:hover { border-color:var(--acid); color:var(--acid); transform:translateY(-1px); }
    button.active,.primary { background:var(--acid); border-color:var(--acid); color:#10130d; font-weight:800; }
    .command-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .command { border-top:2px solid var(--line); padding-top:14px; }
    .command h3 { margin:0 0 10px; color:var(--amber); font-size:14px; text-transform:uppercase; letter-spacing:.12em; }
    .estop { width:100%; min-height:112px; background:var(--danger); border-color:#ff8d86; color:#140201; font-size:32px; font-weight:900; letter-spacing:.08em; box-shadow:inset 0 -8px 0 #a9130a; }
    .estop:hover { color:#140201; border-color:white; transform:translateY(2px); box-shadow:inset 0 -4px 0 #a9130a; }
    .log { height:184px; overflow:auto; margin:0; padding:0; list-style:none; font:12px/1.55 "IBM Plex Mono","SFMono-Regular",Consolas,monospace; }
    .log li { border-bottom:1px dashed #2c3129; padding:6px 0; }
    .log time { color:var(--muted); margin-right:8px; }
    .notice { color:var(--amber); min-height:22px; margin-top:10px; }
    @media (max-width:760px) { main { grid-template-columns:1fr; } header { grid-template-columns:1fr; } .command-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div><div class="eyebrow">Local V4 operator terminal</div><h1>DG-LAB<br>LIVE CONTROL</h1></div>
      <div class="live"><span class="dot"></span><span id="connection">CONNECTING</span></div>
    </header>
    <main>
      <div class="stack">
        <section class="panel" data-index="01"><h2>Pair</h2><div class="qr-wrap" id="qr"></div><p class="mono" id="target">等待 relay hello…</p></section>
        <section class="panel" data-index="02"><h2>Session</h2>
          <div class="status-grid"><div class="metric"><span class="label">APPs</span><strong id="clientCount">0</strong></div><div class="metric"><span class="label">Devices</span><strong id="deviceCount">0</strong></div></div>
          <div class="field" style="margin-top:16px"><label class="label" for="device">Explicit target</label><select id="device"><option value="">请选择设备</option></select></div>
          <div class="field"><span class="label">Channel</span><div class="channels"><button data-channel="A" class="active">A</button><button data-channel="B">B</button></div></div>
          <button id="select" class="primary" style="width:100%">Arm selected target</button><div class="notice" id="notice"></div>
        </section>
      </div>
      <div class="stack">
        <section class="panel" data-index="03"><h2>Control</h2>
          <button class="estop" id="stop">STOP / CLEAR</button>
          <div class="command-grid" style="margin-top:20px">
            <div class="command"><h3>Relative strength</h3><div class="field"><label class="label" for="delta">Delta · max 5</label><input id="delta" type="number" min="1" max="5" value="2"></div><div class="actions"><button id="decrease">− Decrease</button><button id="increase">+ Increase</button></div></div>
            <div class="command"><h3>Temporary intensity</h3><div class="actions"><div class="field"><label class="label" for="intensity">Intensity · max 20</label><input id="intensity" type="number" min="0" max="20" value="10"></div><div class="field"><label class="label" for="tempDuration">Duration ms</label><input id="tempDuration" type="number" min="0" max="5000" value="2000"></div></div><button id="temporary" style="width:100%">Run temporary</button></div>
            <div class="command"><h3>Waveform</h3><div class="field"><label class="label" for="waveform">Compatible preset</label><select id="waveform"></select></div><div class="field"><label class="label" for="waveDuration">Duration ms · max 5000</label><input id="waveDuration" type="number" min="0" max="5000" value="2000"></div><button id="play" style="width:100%">Play waveform</button></div>
            <div class="command"><h3>Reset</h3><p class="mono" style="color:var(--muted)">Clear the selected channel, then set its intensity to zero.</p><button id="zero" style="width:100%">Clear + zero</button></div>
          </div>
        </section>
        <section class="panel" data-index="04"><h2>Event stream</h2><ul class="log" id="log"></ul></section>
      </div>
    </main>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    let state = null;
    let channel = 'A';
    let schema = null;
    const log = (message) => { const item=document.createElement('li'); const time=document.createElement('time'); time.textContent=new Date().toLocaleTimeString(); item.append(time,document.createTextNode(message)); $('log').prepend(item); while($('log').children.length>50) $('log').lastChild.remove(); };
    const api = async (path, body) => { const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}); const data=await response.json(); if(!response.ok) throw new Error(data.error||('HTTP '+response.status)); return data; };
    function currentDevice() { const value=$('device').value; if(!value||!state) return null; const ids=JSON.parse(value); const client=state.clients.find((item)=>item.clientId===ids.clientId); return client && client.devices.find((item)=>item.slotId===ids.slotId); }
    function render(next) {
      state=next; $('connection').textContent=next.socketState.toUpperCase(); $('clientCount').textContent=next.clients.length; $('deviceCount').textContent=next.clients.reduce((sum,item)=>sum+item.devices.length,0);
      $('target').textContent=next.targetId?('TARGET '+next.targetId):'等待 relay hello…'; if(!next.targetId)$('qr').replaceChildren(); if(next.qrDataUrl&&!$('qr').firstChild){const image=new Image();image.src=next.qrDataUrl;image.alt='DG-LAB pairing QR';$('qr').append(image);}
      const prior=$('device').value; $('device').replaceChildren(new Option('请选择设备','')); next.clients.forEach((client)=>client.devices.forEach((device)=>{ const value=JSON.stringify({clientId:client.clientId,slotId:device.slotId}); const option=new Option(device.name+' · '+device.type+' · '+device.slotId,value); $('device').append(option); }));
      if([...$('device').options].some((item)=>item.value===prior)) $('device').value=prior;
      if(next.selection){const selected=JSON.stringify({clientId:next.selection.clientId,slotId:next.selection.slotId}); if([...$('device').options].some((item)=>item.value===selected)) $('device').value=selected; channel=next.selection.channel; renderChannel();}
      renderWaveforms(); if(next.lastError) $('notice').textContent=next.lastError;
    }
    function renderChannel(){document.querySelectorAll('[data-channel]').forEach((button)=>button.classList.toggle('active',button.dataset.channel===channel));}
    function renderWaveforms(){const device=currentDevice(); const names=device&&schema?schema.waveforms[device.type]||[]:[]; const prior=$('waveform').value; $('waveform').replaceChildren(...names.map((name)=>new Option(name,name))); if(names.includes(prior)) $('waveform').value=prior;}
    async function command(kind, fields={}){try{$('notice').textContent='SENDING…';const result=await api('/api/command',Object.assign({kind},fields));$('notice').textContent=result.summary;log(result.summary);}catch(error){$('notice').textContent=error.message;log('ERROR · '+error.message);}}
    document.querySelectorAll('[data-channel]').forEach((button)=>button.onclick=()=>{channel=button.dataset.channel;renderChannel();});
    $('device').onchange=renderWaveforms;
    $('select').onclick=async()=>{try{if(!$('device').value)throw new Error('请先选择设备');const ids=JSON.parse($('device').value);const result=await api('/api/select',Object.assign(ids,{channel}));$('notice').textContent=result.summary;log(result.summary);}catch(error){$('notice').textContent=error.message;}};
    $('stop').onclick=()=>command('stop'); $('zero').onclick=()=>command('zero');
    $('increase').onclick=()=>command('increase',{delta:Number($('delta').value)}); $('decrease').onclick=()=>command('decrease',{delta:Number($('delta').value)});
    $('temporary').onclick=()=>command('temporary',{intensity:Number($('intensity').value),durationMs:Number($('tempDuration').value)});
    $('play').onclick=()=>command('waveform',{name:$('waveform').value,durationMs:Number($('waveDuration').value)});
    Promise.all([api('/api/schema'),api('/api/status?includeQr=1')]).then(([shape,status])=>{schema=shape;render(status);}).catch((error)=>log(error.message));
    const events=new EventSource('/api/events'); events.addEventListener('status',(event)=>render(JSON.parse(event.data))); events.addEventListener('log',(event)=>log(JSON.parse(event.data).message)); events.onerror=()=>log('event stream reconnecting…');
  </script>
</body>
</html>`;
}

class Controller {
  constructor(options) {
    this.relay = options.relay;
    this.limits = options.limits;
    this.socket = new DglabSocket({ url: this.relay });
    this.selection = null;
    this.targetId = null;
    this.qrDataUrl = null;
    this.lastError = null;
    this.lastCommand = null;
    this.commandSequence = 0;
    this.events = [];
    this.listeners = new Set();
    this.touchedTargets = new Map();
    this.closed = false;
    this.bindSocketEvents();
  }

  bindSocketEvents() {
    this.socket.on('state', (state, previous) => {
      this.record(`socket ${previous} -> ${state}`);
      if (state === DGLAB_SOCKET_STATE.Disconnected) this.invalidateSelection('socket disconnected');
      this.broadcast();
    });
    this.socket.on('client-attached', async (clientId) => {
      this.record(`APP attached: ${clientId}`);
      try {
        await this.socket.requestDevices(clientId);
        await this.socket.ping(clientId);
        this.record(`APP verified: ${clientId}`);
      } catch (error) {
        this.fail(`APP verification failed: ${errorMessage(error)}`);
      }
      this.broadcast();
    });
    this.socket.on('client-disconnected', (clientId) => {
      this.record(`APP disconnected: ${clientId}`);
      if (this.selection?.clientId === clientId) this.invalidateSelection('selected APP disconnected');
      this.broadcast();
    });
    this.socket.on('devices', (_devices, clientId) => {
      this.ensureSelectionStillExists(clientId);
      this.broadcast();
    });
    this.socket.on('device', (_device, clientId) => {
      this.ensureSelectionStillExists(clientId);
      this.broadcast();
    });
    this.socket.on('close', (event) => {
      this.record(`relay closed: ${event.code} ${event.reason || ''}`.trim());
      this.targetId = null;
      this.qrDataUrl = null;
      this.invalidateSelection('relay closed');
      this.broadcast();
    });
    this.socket.on('error', (error) => {
      this.fail(`socket error: ${errorMessage(error)}`);
      this.broadcast();
    });
  }

  async connect(terminalQr) {
    const { targetId } = await this.socket.connect();
    if (!targetId || this.socket.state !== DGLAB_SOCKET_STATE.WaitingForPeer) {
      throw new Error('V4 relay hello did not complete');
    }
    this.targetId = targetId;
    const { qrPayload } = pairingPayload(this.relay, targetId);
    this.qrDataUrl = await QRCode.toDataURL(qrPayload, { errorCorrectionLevel: 'M', margin: 2, width: 620 });
    this.record(`relay connected; targetId=${targetId}`);
    if (terminalQr) {
      console.log('Terminal pairing QR:');
      qrcodeTerminal.generate(qrPayload, { small: true }, (code) => process.stdout.write(`${code}\n`));
    }
    this.broadcast();
  }

  record(message) {
    const event = { at: new Date().toISOString(), message };
    this.events.push(event);
    if (this.events.length > 50) this.events.shift();
    for (const listener of this.listeners) listener('log', event);
  }

  fail(message) {
    this.lastError = message;
    this.record(message);
  }

  invalidateSelection(reason) {
    if (this.selection) this.record(`selection cleared: ${reason}`);
    this.selection = null;
  }

  ensureSelectionStillExists(clientId) {
    if (!this.selection || this.selection.clientId !== clientId) return;
    const device = this.socket.getClient(clientId)?.getDevice(this.selection.slotId);
    if (!device) this.invalidateSelection('selected device disappeared');
  }

  clients() {
    return this.socket.clients.map((client) => ({
      clientId: client.clientId,
      devices: client.devices.map(publicDevice),
    }));
  }

  status({ includeQr = false } = {}) {
    const status = {
      ok: true,
      protocol: 'v4',
      relay: this.relay,
      socketState: this.socket.state,
      targetId: this.targetId,
      clients: this.clients(),
      selection: this.selection,
      limits: this.limits,
      lastCommand: this.lastCommand,
      lastError: this.lastError,
      events: this.events,
    };
    if (includeQr) status.qrDataUrl = this.qrDataUrl;
    return status;
  }

  broadcast() {
    const status = this.status();
    for (const listener of this.listeners) listener('status', status);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener('status', this.status());
    return () => this.listeners.delete(listener);
  }

  resolveTarget(input, { allowUnavailable = false } = {}) {
    const source = input.clientId || input.slotId || input.channel
      ? { clientId: input.clientId, slotId: input.slotId, channel: input.channel }
      : this.selection;
    if (!source?.clientId || !source?.slotId || !source?.channel) {
      throw new Error('no active target; call select with clientId, slotId, and channel first');
    }
    const channel = String(source.channel).toUpperCase();
    if (!(channel in CHANNELS)) throw new Error('channel must be A or B');
    const client = this.socket.getClient(source.clientId);
    if (!client) throw new Error('target APP is not attached');
    const device = client.getDevice(source.slotId);
    if (!device) throw new Error('target device is not available');
    if (!allowUnavailable) assertDeviceEligible(device, channel);
    return { clientId: source.clientId, slotId: source.slotId, channel, device };
  }

  select(input) {
    const target = this.resolveTarget(input);
    if (target.device.type === 'BMTR_1') {
      throw new Error('BMTR_1 is discoverable but is not controllable through this console');
    }
    this.selection = {
      clientId: target.clientId,
      slotId: target.slotId,
      deviceType: target.device.type,
      deviceName: target.device.name,
      channel: target.channel,
    };
    this.lastError = null;
    const summary = this.summary(target, 'selected');
    this.record(summary);
    this.broadcast();
    return { ok: true, summary, selection: this.selection };
  }

  summary(target, command) {
    return `APP ${target.clientId} / ${target.device.name} (${target.device.type}) / ${target.slotId} / channel ${target.channel} / ws / ${command}`;
  }

  async command(input) {
    const kind = String(input.kind || '').toLowerCase();
    if (!['stop', 'zero', 'increase', 'decrease', 'temporary', 'waveform'].includes(kind)) {
      throw new Error('kind must be stop, zero, increase, decrease, temporary, or waveform');
    }
    const target = this.resolveTarget(input, { allowUnavailable: kind === 'stop' });
    if (target.device.type === 'BMTR_1' && kind !== 'stop') {
      throw new Error('BMTR_1 does not support intensity or waveform commands through this console');
    }
    const sdkChannel = CHANNELS[target.channel];
    let normalized;
    let operation;
    if (kind === 'stop') {
      normalized = 'stop/clear';
      operation = () => this.socket.clearOperate(target.clientId, { slotId: target.slotId, channel: sdkChannel });
    } else if (kind === 'zero') {
      normalized = 'clear + intensity 0';
      operation = async () => {
        await this.socket.clearOperate(target.clientId, { slotId: target.slotId, channel: sdkChannel });
        await this.socket.resetIntensity(target.clientId, target.slotId, sdkChannel, { immediate: true });
      };
    } else if (kind === 'increase' || kind === 'decrease') {
      const delta = integer(input.delta, 'delta', { min: 1, max: this.limits.delta });
      normalized = `${kind} ${delta}`;
      operation = () => kind === 'increase'
        ? this.socket.addIntensity(target.clientId, target.slotId, sdkChannel, delta, { immediate: true })
        : this.socket.reduceStrength(target.clientId, target.slotId, sdkChannel, delta, { immediate: true });
    } else if (kind === 'temporary') {
      const max = effectiveIntensityMax(target.device, target.channel, this.limits.intensity);
      const intensity = integer(input.intensity, 'intensity', { min: 0, max });
      const durationMs = integer(input.durationMs, 'durationMs', { min: 0, max: this.limits.durationMs });
      normalized = `temporary intensity ${intensity} for ${durationMs}ms`;
      operation = () => this.socket.setTempIntensity(target.clientId, target.slotId, sdkChannel, intensity, durationMs, { immediate: true });
    } else {
      const waveforms = deviceWaveforms(target.device.type);
      if (!waveforms) throw new Error(`device type ${target.device.type} has no compatible waveform set`);
      const name = String(input.name || '').toUpperCase();
      if (!waveforms[name]) throw new Error(`unknown or incompatible waveform: ${input.name || '(missing)'}`);
      const durationMs = integer(input.durationMs, 'durationMs', { min: 0, max: this.limits.durationMs });
      normalized = `waveform ${name} for ${durationMs}ms`;
      operation = () => this.socket.sendPulse(target.clientId, target.slotId, sdkChannel, durationMs, waveforms[name].raw, { immediate: true });
    }

    const summary = this.summary(target, normalized);
    const commandRecord = {
      id: ++this.commandSequence,
      at: new Date().toISOString(),
      kind,
      summary,
      status: 'running',
    };
    this.lastCommand = commandRecord;
    this.touchedTargets.set(`${target.clientId}:${target.slotId}:${target.channel}`, target);
    this.record(`sending: ${summary}`);
    this.broadcast();
    try {
      await operation();
      const completed = { ...commandRecord, status: 'completed' };
      if (this.lastCommand?.id === commandRecord.id) {
        this.lastCommand = completed;
        this.lastError = null;
      }
      if (kind === 'stop' || kind === 'zero') {
        this.touchedTargets.delete(`${target.clientId}:${target.slotId}:${target.channel}`);
      }
      this.record(`completed: ${summary}`);
      this.broadcast();
      return { ok: true, summary, command: completed };
    } catch (error) {
      const failed = { ...commandRecord, status: 'failed', error: errorMessage(error) };
      if (this.lastCommand?.id === commandRecord.id) {
        this.lastCommand = failed;
        this.fail(`command failed: ${errorMessage(error)}`);
      } else {
        this.record(`superseded command failed: ${errorMessage(error)}`);
      }
      this.broadcast();
      throw error;
    }
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const target of this.touchedTargets.values()) {
      if (!this.socket.getClient(target.clientId)) continue;
      try {
        await this.socket.clearOperate(target.clientId, {
          slotId: target.slotId,
          channel: CHANNELS[target.channel],
        });
      } catch (error) {
        this.record(`shutdown clear failed: ${errorMessage(error)}`);
      }
    }
    this.touchedTargets.clear();
    this.socket.destroy(1000, 'local_console_shutdown');
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
    throw new Error('content-type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function schema(controller, port) {
  return {
    name: 'dglab-local-control',
    version: 1,
    baseUrl: `http://${DEFAULT_HOST}:${port}`,
    safetyLimits: controller.limits,
    endpoints: {
      status: 'GET /api/status',
      events: 'GET /api/events (SSE)',
      select: 'POST /api/select {clientId, slotId, channel}',
      command: 'POST /api/command {kind, ...parameters, optional clientId/slotId/channel}',
      shutdown: 'POST /api/shutdown {}',
    },
    commands: {
      stop: { kind: 'stop' },
      zero: { kind: 'zero' },
      increase: { kind: 'increase', delta: 'integer 1..maxDelta' },
      decrease: { kind: 'decrease', delta: 'integer 1..maxDelta' },
      temporary: { kind: 'temporary', intensity: 'integer 0..effectiveMax', durationMs: 'integer 0..maxDurationMs' },
      waveform: { kind: 'waveform', name: 'compatible preset name', durationMs: 'integer 0..maxDurationMs' },
    },
    waveforms: {
      COYOTE_020: Object.keys(COYOTE_WAVEFORMS),
      COYOTE_030: Object.keys(COYOTE_WAVEFORMS),
      OVC_1: Object.keys(OVC_WAVEFORMS),
      BMTR_1: [],
    },
  };
}

async function serve(options) {
  if (options.host && options.host !== DEFAULT_HOST) {
    throw new Error(`this safety-focused example only binds ${DEFAULT_HOST}`);
  }
  const relay = validateRelay(options.relay || DEFAULT_RELAY);
  const port = integer(options.port ?? DEFAULT_PORT, 'port', { min: 1, max: 65_535 });
  const limits = {
    delta: integer(options.maxDelta ?? SAFETY_CEILINGS.delta, 'maxDelta', { min: 1, max: SAFETY_CEILINGS.delta }),
    intensity: integer(options.maxIntensity ?? SAFETY_CEILINGS.intensity, 'maxIntensity', { min: 0, max: SAFETY_CEILINGS.intensity }),
    durationMs: integer(options.maxDurationMs ?? SAFETY_CEILINGS.durationMs, 'maxDurationMs', { min: 0, max: SAFETY_CEILINGS.durationMs }),
  };
  const controller = new Controller({ relay, limits });
  const streams = new Set();
  let shuttingDown = false;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${DEFAULT_HOST}:${port}`);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(htmlPage());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(response, 200, controller.status({ includeQr: url.searchParams.get('includeQr') === '1' }));
      }
      if (request.method === 'GET' && url.pathname === '/api/schema') return sendJson(response, 200, schema(controller, port));
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const unsubscribe = controller.subscribe(send);
        streams.add(response);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000);
        request.on('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/select') {
        return sendJson(response, 200, controller.select(await readJson(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/command') {
        return sendJson(response, 200, await controller.command(await readJson(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/shutdown') {
        await readJson(request);
        sendJson(response, 200, { ok: true, summary: 'console shutdown requested; active tasks will be cleared first' });
        setTimeout(() => stopServer(), 20);
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: errorMessage(error) });
    }
  });

  const stopServer = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await controller.shutdown();
    for (const stream of streams) stream.end();
    streams.clear();
    await new Promise((resolve) => server.close(resolve));
  };

  server.on('error', (error) => controller.fail(`local API error: ${errorMessage(error)}`));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, DEFAULT_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.log(`GUI: http://${DEFAULT_HOST}:${port}/`);
  console.log(`Agent API: http://${DEFAULT_HOST}:${port}/api/schema`);
  console.log('The controller WebSocket will remain live until shutdown.');

  try {
    await controller.connect(Boolean(options.terminalQr));
  } catch (error) {
    await stopServer();
    throw error;
  }

  const signal = async () => {
    await stopServer();
    process.exit(0);
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
}

async function callApi(command, options) {
  const base = String(options.api || process.env[API_ENV] || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`).replace(/\/$/, '');
  let path = '/api/command';
  let method = 'POST';
  let body;
  if (command === 'status') {
    path = '/api/status';
    method = 'GET';
  } else if (command === 'schema' || command === 'waveforms') {
    path = '/api/schema';
    method = 'GET';
  } else if (command === 'select') {
    path = '/api/select';
    body = { clientId: options.clientId, slotId: options.slotId, channel: options.channel };
  } else if (command === 'shutdown') {
    path = '/api/shutdown';
    body = {};
  } else {
    body = {
      kind: command,
      clientId: options.clientId,
      slotId: options.slotId,
      channel: options.channel,
    };
    if (options.delta !== undefined) body.delta = options.delta;
    if (options.intensity !== undefined) body.intensity = options.intensity;
    if (options.durationMs !== undefined) body.durationMs = options.durationMs;
    if (options.name !== undefined) body.name = options.name;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  if (command === 'waveforms') {
    console.log(JSON.stringify(payload.waveforms, null, 2));
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
}

const options = parseArgs(process.argv.slice(2));
const command = options._[0] || 'serve';
const known = ['serve', 'status', 'schema', 'waveforms', 'select', 'stop', 'zero', 'increase', 'decrease', 'temporary', 'waveform', 'shutdown'];
if (!known.includes(command)) usage(`Unknown command: ${command}`);

try {
  if (command === 'serve') await serve(options);
  else await callApi(command, options);
} catch (error) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exit(1);
}
