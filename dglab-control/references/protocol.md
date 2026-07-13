# DG-LAB protocol reference

Use this reference when creating a connection, QR code, or command implementation.

## Defaults

| Protocol | Default | Pairing model |
| --- | --- | --- |
| V4 | `wss://ws.dungeon-lab.cn/` | One controller can pair with multiple APPs; use `clientId` and `slotId` for controls. |
| V3 | `wss://ws.dungeon-lab.cn/` | Legacy one-controller-to-one-APP protocol. |

Pass a user-specified relay URL to `new DglabSocket({ url })`. Do not silently replace it with the default.

## SDK construction

```ts
import {
  DGLAB_SOCKET_VERSION,
  DglabSocket,
} from 'dglab-kit';

const v4 = new DglabSocket({
  url: 'wss://ws.dungeon-lab.cn/',
});

const v3 = new DglabSocket({
  url: 'wss://ws.dungeon-lab.cn/',
  version: DGLAB_SOCKET_VERSION.V3,
});
```

`connect()` returns `targetId`; V4 also returns a `secret` for the relay HTTP API. Treat `secret` as a credential: do not render it into a QR or reveal it in normal output.

## Pairing addresses and QR payloads

Use the controller's `targetId`, not an APP `clientId`.

| Version | APP socket address | QR payload |
| --- | --- | --- |
| V4 | `<relay>?tid=<targetId>` | `https://dungeon-lab.cn/s/?v=1&action=socket&url=<encoded APP socket address>` |
| V3 | `<relay>/<targetId>` | `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#<APP socket address>` |

For V4, use `URL.searchParams.set('tid', targetId)` to preserve an existing relay path or query. For V3, remove trailing slashes before appending `/<targetId>`.

Generate a QR PNG with `qrcode` and render the generated file in the chat response. The pairing address and QR are short-lived: regenerate them after the controller reconnects.

## Command APIs

### V4

After `client-attached`, call `requestDevices(clientId)`. Use the returned `device.slotId` with:

- `resetIntensity(clientId, slotId, channel)`
- `addIntensity(clientId, slotId, channel, value)`
- `reduceStrength(clientId, slotId, channel, value)`
- `setTempIntensity(clientId, slotId, channel, value, durationMs)`
- `sendPulse(clientId, slotId, channel, durationMs, frames)`
- `clearOperate(clientId, { slotId, channel })`

Use `V4Channel.A` or `V4Channel.B`. Obtain waveform `frames` from the exported `COYOTE_WAVEFORMS` or `OVC_WAVEFORMS` collections.

### V3

Use `V3Channel.A` or `V3Channel.B` with:

- `setStrength(channel, value)`
- `addStrength(channel, step)`
- `reduceStrength(channel, step)`
- `sendPulse({ channel: 'A' | 'B', time: seconds, data: frames })`
- `clearPulse(channel)`

V3 does not provide V4-style device discovery or per-device selection.
