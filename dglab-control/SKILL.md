---
name: dglab-control
description: Control paired DG-LAB devices from natural-language instructions with the dglab-kit npm package. Use when building or operating a DG-LAB controller, connecting a V3 or V4 relay, discovering paired devices, translating requests into strength, temporary-intensity, waveform, or clear commands, or generating a scannable DG-LAB pairing QR code. Default to V4 and the official relay; support a user-specified relay or explicit V3 request.
---

# DG-LAB Control

Use `dglab-kit`; do not handcraft protocol frames. Prefer Bun and fall back to Node.js only when Bun is unavailable.

## Prepare

Install the SDK and mature `qrcode` renderer in the controller project:

```bash
bun add dglab-kit qrcode
```

Use `npm install dglab-kit qrcode` only when Bun is unavailable. Read [references/protocol.md](references/protocol.md) before choosing a protocol or forming a pairing URL.

Default to V4 and `wss://ws.dungeon-lab.cn/`. Use a user-provided `ws://` or `wss://` relay unchanged. Switch to V3 only when the user explicitly requests it or needs legacy compatibility.

## Pair before control

1. Connect a `DglabSocket` controller.
2. Receive `targetId` from `await socket.connect()`.
3. Generate a PNG with `scripts/generate-pairing-qr.mjs`, then show the resulting local image to the user with Markdown. Do not expose `secret` in the QR or in user-facing output.
4. Wait for `client-attached`; for V4, call `requestDevices(clientId)` and identify the desired `slotId` before sending a device command.

Run the QR helper from a project where `qrcode` is installed:

```bash
bun scripts/generate-pairing-qr.mjs --target-id "$TARGET_ID" --output ./dglab-pairing.png
```

Pass `--server <ws-url>` for a custom relay and `--version v3` only for V3. After creation, present `![DG-LAB 配对二维码](/absolute/path/dglab-pairing.png)` in the response.

## Translate natural language

Resolve omitted details from the current session only. Treat a direct stop/clear request as highest priority.

| User intent | V4 operation | V3 operation |
| --- | --- | --- |
| Stop, clear, zero | `clearOperate()` or `resetIntensity()` | `clearPulse()` or `setStrength(..., 0)` |
| Increase/decrease | `addIntensity()` / `reduceStrength()` | `addStrength()` / `reduceStrength()` |
| Set a value briefly | `setTempIntensity()` | State the V3 limitation and implement a bounded timer only if requested |
| Play a named built-in waveform | `sendPulse()` with SDK waveform frames | `sendPulse({ channel, time, data })` |

Use only the user-selected paired APP, device, and channel. If there is more than one V4 APP or device and the request does not identify one, ask which target to control. Preserve explicit intensity and duration values; otherwise request the missing action parameters rather than inventing them. Prefer temporary commands for time-bounded requests. Always provide an immediate stop path.

## Use the SDK APIs

For V4, use `V4Channel.A` or `V4Channel.B` and pass both `clientId` and `slotId` to every device operation. For V3, use `V3Channel.A` or `V3Channel.B`; V3 supports one paired APP and has no device discovery.

```ts
import {
  COYOTE_WAVEFORM,
  COYOTE_WAVEFORMS,
  DglabSocket,
  V4Channel,
} from 'dglab-kit';

const socket = new DglabSocket({ url: 'wss://ws.dungeon-lab.cn/' });
const { targetId } = await socket.connect();

socket.on('client-attached', async (clientId) => {
  const { devices } = await socket.requestDevices(clientId);
  const slotId = devices[0]?.slotId;
  if (!slotId) return;

  await socket.setTempIntensity(clientId, slotId, V4Channel.A, 20, 3_000);
  await socket.sendPulse(
    clientId,
    slotId,
    V4Channel.A,
    1_000,
    COYOTE_WAVEFORMS[COYOTE_WAVEFORM.BUBBLE].raw,
  );
});
```

Keep the controller process running while it is paired. On disconnect or a stop request, clear the relevant operation before disposing the session where possible.
