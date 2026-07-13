# DG-LAB protocol and SDK reference

Read this file when connecting, pairing, selecting devices, or mapping an intent to a `dglab-kit` API.

## V4 first, with explicit verification

Create V4 by omitting `version` (the SDK default) or using `DGLAB_SOCKET_VERSION.V4`.

```ts
import { DGLAB_SOCKET_STATE, DglabSocket } from 'dglab-kit';

const socket = new DglabSocket({ url: 'wss://ws.dungeon-lab.cn/' });
const { targetId } = await socket.connect();

if (!targetId || socket.state !== DGLAB_SOCKET_STATE.WaitingForPeer) {
  throw new Error('V4 hello was not completed');
}
```

`connect()` resolves after the V4 relay sends `hello`. This validates the controller-side V4 handshake, not a controllable APP. On `client-attached`, call `await socket.requestDevices(clientId)`; optionally call `await socket.ping(clientId)` to verify the APP RPC path. If either step fails, stop and ask the user to select another relay or explicitly choose V3. Never automatically retry as V3.

Listen for `error`, `close`, `client-disconnected`, `devices`, and `device`. A V4 controller can have multiple APPs; `clientId` identifies an APP and `slotId` identifies a device in it. V4 commands use the controller WebSocket; the relay has no HTTP command API.

## Device slot validation and waveform choice

Use `socket.getClient(clientId)?.devices` after the APP snapshot/event stream is available. Select by explicit user choice or a requested type; never by array position.

Warn and continue without asking for confirmation when an existing slot explicitly reports any of the following:

- `slotState.hasDevice === false`;
- `props.connectState === 'disconnected'`;
- the selected channel is muted;
- an OVC channel reports no attached accessory.

Reject when the requested APP or device slot does not exist, or when the selected channel reports overheat, output damage, or a blocked state.

Use waveform collections only for compatible types:

| Device type | Waveforms |
| --- | --- |
| `COYOTE_020`, `COYOTE_030` | `COYOTE_WAVEFORMS` |
| `OVC_1` | `OVC_WAVEFORMS` |
| `BMTR_1` | No waveform or intensity command through this skill |

Custom waveforms use the same compatible device types. `dglab_play_custom_waveform` accepts 1–50 frames as either hexadecimal strings or integer byte arrays. V2 frames contain 3 bytes (`[a, b, interval]`); V3 frames contain 8 bytes (`[a1, a2, a3, a4, b1, b2, b3, b4]`). Hex strings therefore contain exactly 6 or 16 hexadecimal digits respectively. Use V3 when omitted only if every frame has the V3 shape.

If no compatible device slot exists, report the discovered APP/device status and ask the user to pair, connect, or select another slot.

## V4 commands

Import `V4Channel`. Every device operation needs `(clientId, slotId, channel)`.

```ts
import {
  COYOTE_WAVEFORM,
  COYOTE_WAVEFORMS,
  V4Channel,
} from 'dglab-kit';

await socket.addIntensity(clientId, slotId, V4Channel.A, 2);
await socket.reduceStrength(clientId, slotId, V4Channel.A, 2);
await socket.setTempIntensity(clientId, slotId, V4Channel.A, 10, 2_000);
await socket.sendPulse(
  clientId,
  slotId,
  V4Channel.A,
  2_000,
  COYOTE_WAVEFORMS[COYOTE_WAVEFORM.BUBBLE].raw,
  { immediate: true },
);
await socket.sendPulse(
  clientId,
  slotId,
  V4Channel.A,
  2_000,
  ['0A0A0A0A00000000', '0A0A0A0A64646464'],
  { immediate: true, version: 3 },
);
await socket.clearOperate(clientId, { slotId, channel: V4Channel.A });
```

`reduceStrength()` is the documented V4 API and sends a negative relative adjustment through `addIntensity()`. V4 `resetIntensity()` only sets an absolute value of `0`; do not represent it as a general absolute-strength setter. `device.op` resolves only after its task completes, is cleared, replaced, or cancelled, so use a bounded duration and handle rejected promises.

## V3 compatibility

Use V3 only when explicitly requested:

```ts
import {
  DGLAB_SOCKET_VERSION,
  DglabSocket,
  V3Channel,
} from 'dglab-kit';

const socket = new DglabSocket({
  url: 'wss://ws.dungeon-lab.cn/',
  version: DGLAB_SOCKET_VERSION.V3,
});
```

V3 supports one paired APP, `setStrength`, `addStrength`, `reduceStrength`, `sendPulse`, and `clearPulse`. It has no V4 device discovery or per-device selection. Do not create a timer-based V3 approximation of a temporary intensity unless the user explicitly asks for it; apply the same duration cap and clear it on timeout.

## QR payloads and lifetime

Use the controller `targetId`, never an APP `clientId`.

| Version | APP socket address | QR payload |
| --- | --- | --- |
| V4 | `<relay>?tid=<targetId>` | `https://dungeon-lab.cn/s/?v=1&action=socket&url=<encoded APP socket address>` |
| V3 | `<relay>/<targetId>` | `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#<APP socket address>` |

Use `URL.searchParams.set('tid', targetId)` for V4 and remove trailing slashes before appending the V3 path segment. A QR is valid only for its current controller connection. Mark it stale and regenerate it after reconnect, target ID change, relay change, protocol change, `idle_timeout`, or socket close.

Request `qrOutput: both` for image-capable chat clients. The image is the primary rendering and the terminal QR is the required fallback when a client does not surface MCP image content. A pairing response is incomplete until the user-visible message contains an actual QR rendering and the plain-text connection URL; never substitute wording such as “the QR above” for the rendering itself.

Preserve the relay URL pathname as the global WebSocket prefix. For example, a controller connected to `wss://relay.example/v4` must generate an APP URL at `wss://relay.example/v4?tid=<targetId>`.
