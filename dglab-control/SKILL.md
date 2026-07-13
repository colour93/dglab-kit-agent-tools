---
name: dglab-control
description: Control paired DG-LAB devices from natural-language instructions with the dglab-kit npm package. Use when building or operating a DG-LAB controller, connecting a V3 or V4 relay, discovering paired devices, translating requests into bounded strength, temporary-intensity, waveform, or stop commands, or generating a scannable DG-LAB pairing QR code. Default to verified V4 and the official relay; support a user-specified relay or explicit V3 request.
---

# DG-LAB Control

Use `dglab-kit`; never handcraft protocol frames. Prefer Bun and fall back to Node.js only when Bun is unavailable.

## Non-negotiable rules

- Default to V4 at `wss://ws.dungeon-lab.cn/`; preserve a user-provided `ws://` or `wss://` relay. Do not silently downgrade to V3.
- Treat a socket as V4-capable only after `connect()` receives `hello`, an APP attaches, and `requestDevices(clientId)` succeeds. Offer a relay change or explicit V3 selection if this fails.
- Use only the active session target: `clientId`, `slotId`, `deviceType`, channel, and selected transport. Stop immediately on a direct stop/clear/zero request.
- Apply [references/safety.md](references/safety.md) before every device command. Clear selected tasks before an intentional disconnect; invalidate session state on any disconnect.
- Keep protocol facts in [references/protocol.md](references/protocol.md), transport routing in [references/transport.md](references/transport.md), and intent normalization in [references/intent-contract.md](references/intent-contract.md).

## Connect and pair

Install dependencies in the controller project:

```bash
bun add dglab-kit qrcode qrcode-terminal
```

Use `npm install dglab-kit qrcode qrcode-terminal` only when Bun is unavailable.

1. Create a V4 `DglabSocket` and await `connect()`.
2. Generate a QR PNG with `scripts/generate-pairing-qr.mjs` from its `targetId`.
3. Render the generated absolute PNG path when the agent can show images; for CLI-only agents, add `--terminal` to render the same QR in the terminal. Never put `secret` in user-facing output.
4. On `client-attached`, verify the APP with `requestDevices(clientId)` and select an eligible device before control.

```bash
bun scripts/generate-pairing-qr.mjs --target-id "$TARGET_ID" --output ./dglab-pairing.png
```

Pass `--terminal` for a CLI QR, `--server <ws-url>` for a custom relay, and `--version v3` only for an explicit V3 session. Regenerate the QR after every controller reconnect, relay/protocol change, or `targetId` change; discard old images and URLs.

## Select a transport

Use V4 WebSocket for connection, pairing, device discovery, state/events, or a user-selected `ws` command. For a single V4 control RPC after pairing, prefer HTTP when the live controller has a `secret` and a valid HTTP endpoint. Respect an explicit `http` or `ws` choice. In automatic mode, use HTTP only for one-off dispatch; otherwise use WebSocket. HTTP never replaces the live controller WebSocket.

## Handle natural-language commands

Accept hardware control only through the active controller interaction described in [references/intent-contract.md](references/intent-contract.md). Normalize the message, resolve the transport, validate the selected target and safety policy, then state the target, transport, and bounded command before sending it.

| Intent | Missing data |
| --- | --- |
| stop / clear / zero | Execute immediately for the active target; ask only if no target exists. |
| custom or ambiguous wording | Ask the user to restate it as a supported command with explicit parameters. |
| increase / decrease | Require an explicit delta. |
| temporary intensity | Require an explicit intensity and duration. |
| waveform | Require a compatible waveform and duration. |
| select device / channel | Ask for an unambiguous selection. |

Persist a confirmed target only for the current live session. Reuse it for later messages, but invalidate it on APP/device removal, controller reconnect, relay/protocol change, or disconnect. If multiple eligible APPs or devices exist and none is selected, ask the user instead of choosing `devices[0]`.

## Send through the SDK

For V4, use `V4Channel.A` or `V4Channel.B` and pass `clientId` plus `slotId` to every operation. `reduceStrength()` is the SDK's actual V4 method name for relative decrements. Use `clearOperate(clientId, { slotId, channel })` to stop selected work.

For V3, use `V3Channel.A` or `V3Channel.B`. V3 has one paired APP and no per-device discovery; retain the same target and safety rules, but do not emulate V4 discovery.

On normal shutdown, clear the active V4 task first, then call `disconnect()` or `destroy()`. After a close event, do not attempt to send; report the command as not delivered and require a fresh pairing session.
