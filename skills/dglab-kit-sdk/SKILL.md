---
name: dglab-kit-sdk
description: Build, review, or refactor TypeScript and JavaScript integrations that use the dglab-kit SDK. Use when installing or configuring the dglab-kit package, implementing V4 relay connection and APP pairing, tracking APPs and devices, selecting safe device targets, controlling intensity or waveforms, cleaning up tasks, integrating a custom WebSocket transport or V4 HTTP RPC, or migrating legacy V3 code. This is a coding skill for application development; do not use it to operate a live device through the dglab MCP server.
---

# DG-LAB Kit SDK Development

Implement application-owned integrations with the `dglab-kit` package. Keep this skill independent from `dglab-control` and the repository's MCP server.

## Establish the integration context

1. Inspect the target project's runtime, package manager, module format, framework, and existing WebSocket lifecycle.
2. Inspect the installed `dglab-kit` version and its exported types. Treat the target project's installed package as authoritative when it differs from these references.
3. Prefer V4 for new work. Preserve V3 only for an explicit compatibility requirement.
4. Determine the relay URL, pairing presentation, target-selection UX, and application safety limits from existing requirements. Ask only when a choice materially changes the implementation.
5. Install only `dglab-kit` and dependencies required by the application. Do not install, configure, or call the DG-LAB MCP server unless the user separately requests it.

Read [references/v4-api.md](references/v4-api.md) before using the SDK API. Read [references/implementation-patterns.md](references/implementation-patterns.md) when implementing connection lifecycle, target state, command scheduling, cleanup, browser/manual transport, or HTTP delivery.

## Build around a long-lived controller

- Own one `DglabSocket` instance in a service or controller rather than inside a render path or per request.
- Register `state`, `error`, `close`, `client-attached`, `client-disconnected`, and `devices` listeners before calling `connect()`.
- Keep the `secret` returned by V4 `connect()` server-side. Never place it in a pairing URL, browser log, analytics event, or user-visible response.
- Generate the APP URL with `URL` and query parameter `tid`; encode that URL into the DG-LAB pairing link. Do not concatenate untrusted relay URLs.
- Key state first by APP `clientId`, then by device `slotId`. Never confuse either identifier with the controller `targetId`.
- Request devices after `client-attached`, then maintain the SDK's merged device view through `clients`, `getClient()`, and `devices` events.
- Require an explicit APP, device, and channel choice when more than one valid target exists. Invalidate the choice on APP disconnect, device removal, socket close, or reconnect.

## Put a safety boundary before SDK calls

The SDK transports commands; it does not impose product safety ceilings. Implement an application command layer that:

- accepts finite integers only and rejects missing or out-of-range values instead of silently coercing them;
- defines configurable ceilings for relative delta, temporary intensity, task duration, and custom waveform size;
- caps intensity at the smaller of the application ceiling and the selected channel's reported `intensityMax` when available;
- blocks overheated, damaged, or disabled channels and surfaces disconnected, empty-slot, muted, or unattached-accessory states;
- checks waveform compatibility by device type and validates every custom V2/V3 frame;
- serializes operations per `clientId + slotId + channel`, while giving clear/stop requests priority over queued work;
- records every touched target so shutdown can clear only the tasks this controller may have started.

Use conservative, configurable defaults when the product has no policy yet; call out that the product owner must approve them.

## Use the highest-level supported method

- Prefer `requestDevices`, `ping`, `resetIntensity`, `addIntensity`, `reduceStrength`, `setTempIntensity`, `sendPulse`, and `clearOperate` over handcrafted frames.
- Use `send()` only for a supported V4 RPC that the installed SDK does not wrap. Type and validate the payload, and preserve RPC error handling.
- Use `immediate: true` only when the product intends a newer task to replace an older task of the same target and type.
- Remember that device operations resolve when the task finishes, is cleared, is replaced, or is cancelled—not merely when queued.
- When setting a custom global `responseTimeout`, pass a per-operation timeout longer than long-running task duration.
- Treat `clearOperate` as the stop path. Clear touched targets before `destroy()` during explicit shutdown, reconnect, and process lifecycle hooks.
- Use `destroy()` for final disposal so SDK and consumer listeners are removed; use `disconnect()` only when retaining the instance and listeners is intentional.

## Deliver application code

- Match the project's existing conventions and keep protocol details behind a small typed adapter.
- Expose connection state, pairing data, APP/device inventory, selection, warnings, and command results as separate application states.
- Handle rejected promises and `error`/`close` events without claiming command delivery.
- Document the relay requirement and the user-visible pairing flow near the integration entry point.
- Do not operate a real device as part of implementation or verification unless the user separately asks for live control.
