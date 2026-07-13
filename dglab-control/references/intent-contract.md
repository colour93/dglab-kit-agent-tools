# Chat-to-controller intent contract

Read this file before turning a user message into a hardware call.

## Trigger and normalized command

Accept a hardware command only when it is sent to the active controller interaction (for example, by invoking `$dglab-control` or addressing the existing controller task). Treat ordinary chat text as non-operative. A new task has no selected device.

Normalize an accepted command before sending it:

```ts
type Command = {
  kind: 'stop' | 'increase' | 'decrease' | 'temporary' | 'waveform' | 'select';
  clientId?: string;
  slotId?: string;
  deviceType?: 'COYOTE_020' | 'COYOTE_030' | 'OVC_1' | 'BMTR_1';
  channel?: 'A' | 'B';
  transport?: 'auto' | 'ws' | 'http';
  delta?: number;
  intensity?: number;
  durationMs?: number;
  waveform?: string;
};
```

Resolve an explicit APP, device, or channel from the message first. Otherwise use the active session selection. If neither is available or it is stale, ask the user to select from the eligible devices; never infer from ordering.

Resolve transport independently of target selection. Accept “通过 WebSocket” / `ws` and “通过 HTTP” / `http` as explicit choices. If omitted, use `auto` as defined in [transport.md](transport.md).

## Intent mapping

| User wording | Normalized command | Required values | SDK call |
| --- | --- | --- | --- |
| “停止”, “清除”, “归零” | `stop` | active target | `clearOperate()`; optionally `resetIntensity()` for zero |
| “加/减 N” | `increase` / `decrease` | `delta` | `addIntensity()` / `reduceStrength()` |
| “强度 N，持续 T” | `temporary` | `intensity`, `durationMs` | `setTempIntensity()` |
| “播放 <波形> T 秒” | `waveform` | compatible waveform, `durationMs` | `sendPulse()` |
| “选 X 的 A 通道” | `select` | unambiguous target | update session only |
| “通过 HTTP / WS 发送” | any control command | compatible V4 session | set `transport` |
| “测试”等项目自定义术语 | — | explicit standard command and parameters | ask; do not send hardware commands |

Do not reserve a generic `test` command. `dglab-kit` has no such API, and individual controller projects may give the word different meanings. A project may document its own explicit command template outside this skill; otherwise ask the user for the target operation and parameters.

## Selection lifecycle

Store a confirmed selection as `{ clientId, slotId, deviceType, channel }` and an optional transport preference for the current live controller session. Before each non-stop command, echo the selected target and transport in the command summary and revalidate it against the latest device state.

Clear the selection on `client-disconnected`, device removal, socket `close`, controller reconnect, `idle_timeout`, relay change, protocol change, or a changed `targetId`. Ask for fresh selection rather than carrying it across those boundaries.
