# dglab-kit V4 API contract

This reference reflects the public TypeScript source of `dglab-kit` 1.0.0. Check the installed package's types when working with another version.

## Contents

- [Runtime and construction](#runtime-and-construction)
- [Connection and identity](#connection-and-identity)
- [Events and device state](#events-and-device-state)
- [V4 methods](#v4-methods)
- [Waveforms](#waveforms)
- [Task and error semantics](#task-and-error-semantics)
- [Manual transport and HTTP](#manual-transport-and-http)
- [V3 compatibility](#v3-compatibility)

## Runtime and construction

- Package: `dglab-kit`
- Runtime baseline: Node.js 22+; Bun and browsers are also supported.
- Default protocol: V4.
- Default connection timeout: `8000 ms`.
- Default V4 response timeout: `8000 ms`.

```ts
import { DglabSocket } from 'dglab-kit';

const socket = new DglabSocket({
  url: 'wss://ws.dungeon-lab.cn/',
  connectTimeout: 8_000,
  responseTimeout: 8_000,
});
```

Constructor options are `url?`, `protocols?`, `connectTimeout?`, `responseTimeout?`, and `version?`. Omitting `url` enables manual transport mode.

## Connection and identity

```ts
const { targetId, secret } = await socket.connect();
```

- `targetId`: controller identity used only to pair an APP.
- `secret`: V4 HTTP API key; keep it private.
- `clientId`: identity of one attached APP. Every APP-facing V4 call requires it.
- `slotId`: identity of one device exposed by an APP.
- `V4Channel.A` / `V4Channel.B`: protocol values `0` / `1`.

Build pairing data with `tid`, not `targetId`:

```ts
const appSocketUrl = new URL(relayUrl);
appSocketUrl.searchParams.set('tid', targetId);

const pairingUrl = new URL('https://dungeon-lab.cn/s/');
pairingUrl.searchParams.set('v', '1');
pairingUrl.searchParams.set('action', 'socket');
pairingUrl.searchParams.set('url', appSocketUrl.toString());
```

Socket states are `idle`, `connecting`, `waiting_for_peer`, `paired`, and `disconnected` through `DGLAB_SOCKET_STATE`.

## Events and device state

Register listeners before `connect()`:

| Event | Callback | Purpose |
| --- | --- | --- |
| `state` | `(state, previous)` | Drive connection UI and invalidate stale state. |
| `error` | `(error)` | Report transport or protocol errors. |
| `close` | `(event)` | Handle final close code/reason and clear selection. |
| `client-attached` | `(clientId)` | Request the APP's current devices. |
| `client-disconnected` | `(clientId)` | Remove the APP and reject its pending work. |
| `devices` | `(devices, clientId)` | Consume the SDK's current merged device list. |
| `device` | `(event, clientId)` | Observe a single complete or partial device change. |
| `action` | `(action)` | Receive APP custom actions `0..9`. |
| `data` | `(data, clientId?)` | Observe APP application payloads. |

V4 exposes `clientIds`, `clients`, and `getClient(clientId)`. A client exposes `devices` and `getDevice(slotId)`. The SDK updates this cache from `devices.snapshot`, `devices.patch`, `slots.patch`, and `devices.get` responses; prefer this view over maintaining a second incompatible merge implementation.

Every device has `slotId`, `name`, and `type`, with optional `props` and `slotState`. Common state includes:

- `slotState.hasDevice`: whether a real device is present.
- `props.connectState`: commonly `connected` or `disconnected`.
- Coyote/OVC `slotState.channelA/channelB.isMuted`.
- Coyote `slotState.channelA/channelB.intensityMax` and `comfortLimit.overheat`.
- Coyote V3 `props.channelAStatus/channelBStatus`: `3` damaged, `4` blocked.
- OVC `props.channelAStatus/channelBStatus`: whether an accessory is attached.

Known device types are `COYOTE_020`, `COYOTE_030`, `OVC_1`, and `BMTR_1`. Do not assume that intensity and waveform operations apply to every type.

## V4 methods

All device commands return promises and should be awaited or deliberately supervised.

```ts
await socket.ping(clientId, { timeout: 3_000 });
const { devices } = await socket.requestDevices(clientId);

await socket.resetIntensity(clientId, slotId, V4Channel.A);
await socket.addIntensity(clientId, slotId, V4Channel.A, 2, {
  immediate: true,
});
await socket.reduceStrength(clientId, slotId, V4Channel.A, 2, {
  immediate: true,
});
await socket.setTempIntensity(
  clientId,
  slotId,
  V4Channel.A,
  10,
  2_000,
  { immediate: true, timeout: 3_000 },
);
```

Operation options:

- `timeout`: wait time for the RPC response.
- `priority`: `0 | 1 | 2`.
- `immediate`: replace tasks of the same device, channel, and type.

Clear scopes:

```ts
await socket.clearOperate(clientId);
await socket.clearOperate(clientId, { slotId });
await socket.clearOperate(clientId, { slotId, channel: V4Channel.A });
```

Never pass a channel without a `slotId`.

## Waveforms

Use `COYOTE_WAVEFORMS` with Coyote devices and `OVC_WAVEFORMS` with OVC devices. Each entry contains localized labels and `raw: string[]` frames.

```ts
import {
  COYOTE_WAVEFORM,
  COYOTE_WAVEFORMS,
  V4Channel,
} from 'dglab-kit';

await socket.sendPulse(
  clientId,
  slotId,
  V4Channel.A,
  1_000,
  COYOTE_WAVEFORMS[COYOTE_WAVEFORM.BUBBLE].raw,
  { immediate: true, timeout: 2_000 },
);
```

Custom frames:

- V2: exactly 3 integer bytes or 6 hexadecimal digits per frame; pass `{ version: 2 }`.
- V3: exactly 8 integer bytes or 16 hexadecimal digits per frame; omit `version` or pass `{ version: 3 }`.
- Keep one representation and version per request. Validate byte ranges `0..255`, frame count, and duration before calling the SDK.

## Task and error semantics

`device.op` responses arrive after completion, clearing, replacement, or cancellation. Expected result reasons include `completed`, `cleared`, `replaced`, and `cancelled`.

Common RPC errors include `duplicate_request_id`, `invalid_params`, `slot_not_found`, `invalid_operate`, `method_not_found`, and `internal_error`. The SDK also rejects pending work on APP or socket disconnect and uses named errors for connect, send, ping, and response timeouts.

The SDK automatically extends the default operation response timeout to `duration + 1000 ms` when the duration exceeds its default timeout. If the caller configures a global `responseTimeout`, that automatic extension no longer applies; pass a sufficient operation `timeout` explicitly.

Use `disconnect()` to close transport while keeping the wrapper listeners. Use `destroy()` for final disposal; it disconnects and removes SDK and consumer listeners. Neither method implicitly clears device tasks, so call `clearOperate()` first for targets the application touched.

## Manual transport and HTTP

For a custom WebSocket implementation, omit `url`, set the sender, and forward all four lifecycle events:

```ts
const socket = new DglabSocket();
socket.setSender((data) => ws.send(data));
ws.addEventListener('open', (event) => socket.handleOpen(event));
ws.addEventListener('message', (event) => socket.handleMessage(event.data));
ws.addEventListener('close', (event) => socket.handleClose(event));
ws.addEventListener('error', (event) => socket.handleError(event));
await socket.connect();
```

V4 HTTP delivery uses `POST /message` or `POST /v4/message`, the `apikey` or `x-apikey` header, and body `{ type: 'message', clientId, data }`. Use it for server-side RPC delivery only. It cannot receive `devices.snapshot`, `slots.patch`, `custom.action`, or other push events. Never expose `secret` to a browser merely to use HTTP delivery.

## V3 compatibility

Enable V3 only with `version: DGLAB_SOCKET_VERSION.V3`. V3 has one paired APP, different methods and duration units, and is deprecated for new integrations. Keep V3 and V4 adapters separate rather than branching throughout domain code.
