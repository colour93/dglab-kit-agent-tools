# DG-LAB Kit: LLM Integration Contract

This document is the compact, machine-oriented contract for agents operating this repository. For end-user setup, read [README.md](README.md).

## Purpose and boundaries

The project exposes a local stdio MCP server for DG-LAB V4 and a Codex skill that maps natural-language requests to MCP calls.

- Use the MCP tools; do not construct protocol frames or create a second socket controller.
- The MCP owns relay state, controller state, target selection, command queues, and enforcement of configured ceilings.
- The skill owns intent validation, user-facing selection, and pre-call safety checks.
- The server does not start a network listener unless embedded relay mode is explicitly selected.
- Embedded relay mode requires Bun because it uses `Bun.serve()`; remote mode also works on Node.js 22+.

Relevant files:

| Path | Role |
| --- | --- |
| `mcp/src/index.ts` | MCP tool registration, configuration, lifecycle |
| `mcp/src/controller.ts` | V4 connection, discovery, target state, safety, queues |
| `mcp/src/relay/manager.ts` | Embedded relay configuration and address discovery |
| `mcp/src/relay/v4-relay.ts` | Bun WebSocket relay implementation |
| `skills/dglab-control/SKILL.md` | Agent workflow |
| `skills/dglab-control/references/intent-contract.md` | Natural-language normalization |
| `skills/dglab-control/references/safety.md` | Mandatory safety policy |
| `skills/dglab-control/references/protocol.md` | SDK and V4 protocol facts |

When documentation and runtime code differ, treat MCP schemas and validation in `mcp/src/index.ts` and `mcp/src/controller.ts` as authoritative.

## Installation and launch

Preferred runtime:

```bash
cd mcp
bun install
bun run src/index.ts
```

Remote-only Node.js alternative:

```bash
cd mcp
npm install
npm run start:node
```

Minimal Codex MCP configuration:

```toml
[mcp_servers.dglab]
command = "bun"
args = ["run", "/absolute/path/to/repo/mcp/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 30

[mcp_servers.dglab.env]
DGLAB_RELAY_MODE = "remote"
DGLAB_RELAY = "wss://ws.dungeon-lab.cn/"
```

Install or link `skills/dglab-control` into the Codex skills directory. Invoke it as `$dglab-control`.

## Required agent workflow

1. Resolve relay mode. Default to `remote` and `wss://ws.dungeon-lab.cn/` unless the user chose another relay.
2. Call `dglab_connect`. Use `qrOutput: "both"` for image-capable clients and `"terminal"` only for text-only CLI clients. Omitting the option also defaults to `"both"`.
3. Put an actual image or terminal QR in the user-visible response and always show the returned plain-text `Connection URL` directly below it. Never claim a QR is “above” unless it is visibly present.
4. After the APP scans the QR, call `dglab_status` until device slots are discovered.
5. If multiple APPs or device slots exist, ask the user to choose. Never select by array order.
6. Call `dglab_select_target` with exact `clientId`, `slotId`, and channel.
7. Before every non-stop device command, validate current state and state the selected APP/device/channel, bounded command, and any warning-only states. This is a notice, not a confirmation request.
8. Map explicit supported intents and aliases that the user fully defined in the active interaction to tools. An undefined ambiguous word such as “test” still requires clarification.
9. Execute stop/clear requests immediately through `dglab_stop`; stop takes priority over queued work.
10. Use `dglab_disconnect` for normal shutdown.

A new task has no selected device. Selection is process-local and must not be assumed across MCP restarts or reconnections.

## Tool contract

### Relay and session tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `dglab_list_relay_addresses` | `port?`, `prefix?` | Lists loopback/private IPv4 candidates. If no port is configured, reserves one random port in `49152..65535` for the next embedded start; does not listen. |
| `dglab_start_relay` | embedded relay fields | Starts Bun-only embedded relay. Disconnects the current controller first. |
| `dglab_stop_relay` | none | Clears/disconnects the controller and stops the embedded relay. |
| `dglab_connect` | `mode?`, remote or embedded fields, `qrOutput?` (`image`, `terminal`, `both`) | Connects remote V4 or starts/uses embedded V4. Defaults to image plus terminal fallback and returns the plain-text APP URL. |
| `dglab_status` | none | Returns relay state, APPs, devices, compatible waveforms, selection, limits, and recent events. |
| `dglab_disconnect` | `keepEmbeddedRelay?` | Clears touched channels and disconnects; stops embedded relay unless explicitly retained. |

Embedded relay fields:

| Field | Meaning |
| --- | --- |
| `bindHost` | Actual listening interface; safe default is `127.0.0.1`. |
| `port` | Listening port; omitted means a random high port. |
| `prefix` | Global WebSocket path prefix; default `/`. |
| `controllerUrl` | URL used locally by the MCP controller. |
| `advertisedUrl` | APP-facing URL embedded in the pairing payload. |
| `allowNetworkExposure` | Must be `true` for any non-loopback bind. |

Remote mode uses `relay`, a `ws://` or `wss://` V4 Relay URL.

### Target and device tools

| Tool | Required input | Preconditions |
| --- | --- | --- |
| `dglab_select_target` | `clientId`, `slotId`, `channel` (`A` or `B`) | Exact APP/device slot/channel exists. Disconnected-device and muted-channel states return warnings. |
| `dglab_increase` | `delta` | Active target; integer `1..configured max delta`. |
| `dglab_decrease` | `delta` | Active target; integer `1..configured max delta`. |
| `dglab_set_temporary` | `intensity`, `durationMs` | Active target; both integers within configured/device bounds. Returns to zero at task end. |
| `dglab_play_waveform` | `name`, `durationMs` | Active target; name appears in compatible waveforms from status. |
| `dglab_stop` | optional complete target | Use active selection, or provide all of `clientId`, `slotId`, and `channel`. Cancels queued work before clearing. |

Do not partially specify a target to `dglab_stop`. Do not issue intensity or waveform commands to `BMTR_1`. Compatible waveform families are reported by `dglab_status` and derive from device type.

Bounded device-output tools intentionally publish `destructiveHint: false` so clients do not turn every already-requested command into another approval step. Runtime ceilings, target validation, serialization, and hard device-fault checks remain enforced. Starting a network-exposed relay remains a higher-risk operation.

## Natural-language intent mapping

| User intent | Required explicit data | Tool |
| --- | --- | --- |
| stop / clear | active or complete explicit target | `dglab_stop` |
| increase N | positive integer delta | `dglab_increase` |
| decrease N | positive integer delta | `dglab_decrease` |
| intensity N for T | intensity and duration | `dglab_set_temporary` |
| play waveform X for T | compatible name and duration | `dglab_play_waveform` |
| select device/channel | unambiguous APP, slot, channel | `dglab_select_target` |

If required data is missing, ask for it. Reject out-of-policy values rather than silently clamping. A custom alias may reuse a fully specified bounded command template the user defined earlier in the active interaction; otherwise ask for explicit parameters.

## Safety invariants

Default ceilings:

| Limit | Default | Environment variable |
| --- | ---: | --- |
| Relative delta per call | `5` | `DGLAB_MAX_DELTA` |
| Temporary intensity | `20` | `DGLAB_MAX_INTENSITY` |
| Temporary/waveform duration | `5000 ms` | `DGLAB_MAX_DURATION_MS` |

Environment variables may only make these defaults stricter; runtime validation rejects larger values. Effective intensity maximum is the smaller of the configured ceiling and the device-reported channel maximum when available.

Before a device command:

- Confirm the controller is connected, the APP and requested slot exist, and the target channel is still selected.
- Warn but continue for `hasDevice: false`, a disconnected device, a muted channel, or an unattached OVC accessory; do not ask for another confirmation.
- Reject a missing APP/slot, overheated channel, damaged output, or blocked channel.
- Require finite integers and explicit parameters.
- Never bypass MCP validation with SDK calls or handcrafted frames.
- Never claim delivery after disconnect or tool failure.

Network safety:

- Never infer or silently enable a non-loopback bind.
- Non-loopback `bindHost` requires an explicit user request, `allowNetworkExposure: true`, and an explicit APP-reachable `advertisedUrl`.
- `127.0.0.1` in an APP QR refers to the APP device itself; it normally cannot reach the computer from a phone.
- Do not expose the embedded relay directly to the public internet. It provides WebSocket forwarding, not user authentication or an HTTP API.

## State invalidation

Invalidate the selected target and require fresh discovery/selection after any of:

- APP or device removal;
- socket close or `idle_timeout`;
- controller reconnect;
- relay or protocol change;
- changed `targetId`;
- MCP process restart.

Pairing QR codes are connection-specific and become stale after reconnect, relay change, target change, timeout, or close.

## Configuration reference

Resolution order is: current MCP tool arguments, then environment variables, then safe defaults.

| Variable | Default |
| --- | --- |
| `DGLAB_RELAY_MODE` | `remote` |
| `DGLAB_RELAY` | `wss://ws.dungeon-lab.cn/` |
| `DGLAB_EMBEDDED_BIND_HOST` | `127.0.0.1` |
| `DGLAB_EMBEDDED_PORT` | random `49152..65535` |
| `DGLAB_EMBEDDED_PREFIX` | `/` |
| `DGLAB_EMBEDDED_CONTROLLER_URL` | generated from bind/port/prefix |
| `DGLAB_EMBEDDED_ADVERTISED_URL` | controller URL for loopback only |
| `DGLAB_EMBEDDED_ALLOW_NETWORK_EXPOSURE` | `false` |

Typical LAN configuration:

```text
bindHost: 0.0.0.0
port: 9998
prefix: /v4
controllerUrl: ws://127.0.0.1:9998/v4
advertisedUrl: ws://192.168.1.20:9998/v4
allowNetworkExposure: true
```

The advertised private IPv4 address must belong to the MCP host and be reachable from the APP device.

## Lifecycle notes

- MCP transport is stdio.
- Startup does not automatically connect to V4.
- `dglab-kit` normally waits about 8 seconds for Relay `hello` during connect.
- The embedded relay disconnects an unattached controller after a 5-minute idle timeout.
- Normal commands for the same device channel are serialized.
- `dglab_stop` invalidates pending queued commands and clears the selected channel without waiting for that queue.
- MCP shutdown attempts to clear touched channels, disconnect the controller, and stop the embedded relay.
