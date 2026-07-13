---
name: dglab-control
description: Control paired DG-LAB devices through the local dglab-kit MCP server. Use when connecting the V4 relay, pairing an APP, discovering or selecting devices, translating natural language into bounded strength, temporary-intensity, waveform, stop, or disconnect tool calls, or explaining the active DG-LAB session.
---

# DG-LAB Control

Use the local `dglab-kit` stdio MCP tools. Do not write protocol frames or start an independent socket controller while the MCP session is available.

## Non-negotiable rules

- Default to remote V4 at `wss://ws.dungeon-lab.cn/`; preserve an explicitly selected remote or embedded relay.
- Never bind an embedded relay beyond loopback without an explicit user request, `allowNetworkExposure: true`, and an APP-reachable `advertisedUrl`.
- Treat the session as controllable only after `dglab_connect`, APP attachment, discovery of the requested device slot, and explicit `dglab_select_target`.
- Use only the active session target: `clientId`, `slotId`, `deviceType`, and channel. Stop immediately on a direct stop or clear request.
- Apply [references/safety.md](references/safety.md) before every device command. The MCP also enforces the same ceilings and serializes commands per selected channel.
- Keep protocol facts in [references/protocol.md](references/protocol.md) and intent normalization in [references/intent-contract.md](references/intent-contract.md).

## Connect and pair

1. Resolve relay mode. Use remote by default. For embedded mode, call `dglab_list_relay_addresses`, preserving the requested global path prefix, present viable addresses, and ask the user to select one when the APP is on another device. Preserve its randomly selected high port unless the user specifies a port.
2. Choose `qrOutput: both` in a GUI or any interface that can display or attach response images; choose `qrOutput: terminal` only in a text-only CLI. Call `dglab_connect`, then place the returned image QR in the user-visible response with the terminal QR as fallback and the `Connection URL` as plain text directly below it. Do not merely say “scan the QR above”: verify the response actually contains a visible image or terminal QR. Never claim the QR was sent when only the URL or instructions are visible.
3. After the APP scans the QR, call `dglab_status` until device slots are present.
4. If more than one APP or device exists, ask the user to choose. Never select by array position.
5. Call `dglab_select_target` with an exact `clientId`, `slotId`, and channel.

## Handle natural-language commands

Accept hardware control only through the active interaction described in [references/intent-contract.md](references/intent-contract.md). Normalize the message, validate the selected target and safety policy, then state the target and bounded command before calling the corresponding MCP tool. This statement is a notification, not a confirmation request. Once the user has supplied an explicit bounded command, execute it without asking again.

| Intent | Missing data |
| --- | --- |
| stop / clear | Call `dglab_stop` immediately; ask only if no active or explicit target exists. |
| custom or ambiguous wording | Use a command template the user explicitly defined in the active interaction; otherwise ask for explicit parameters. |
| increase / decrease | Require an explicit delta. |
| temporary intensity | Require an explicit intensity and duration. |
| waveform | Require a compatible waveform and duration. |
| select device / channel | Ask for an unambiguous selection. |

The MCP persists a selected target only for its current process. Reuse it for later messages, but call `dglab_status` after APP/device removal, reconnect, relay change, or disconnect. If multiple APPs or device slots exist and none is selected, ask the user instead of choosing the first item. A reported disconnected device, `hasDevice: false`, muted channel, or unattached OVC accessory is warning-only: tell the user output may have no physical effect, then execute without requesting approval. A missing requested slot, overheat, output damage, or blocked channel remains a hard failure.

## Use the MCP tools

- Use `dglab_increase` and `dglab_decrease` only with an explicit bounded delta.
- Use `dglab_set_temporary` only with explicit intensity and duration.
- Use `dglab_play_waveform` only with a compatible waveform returned by `dglab_status`.
- Use `dglab_stop` as the priority path; it cancels queued work for the channel before clearing it.
- Use `dglab_start_relay` and `dglab_stop_relay` only for an explicitly requested embedded relay lifecycle.
- Use `dglab_disconnect` for normal shutdown; it clears touched channels and stops an embedded relay unless the user explicitly keeps it running.

After a disconnect, do not claim that a command was delivered. Require `dglab_connect`, pairing, discovery, and selection again.
