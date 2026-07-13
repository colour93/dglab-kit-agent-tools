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
  delta?: number;
  intensity?: number;
  durationMs?: number;
  waveform?: string;
};
```

Resolve an explicit APP, device, or channel from the message first. Otherwise use the active session selection. If neither is available or it is stale, ask the user to select from the eligible devices; never infer from ordering.

## Intent mapping

| User wording | Normalized command | Required values | MCP tool |
| --- | --- | --- | --- |
| “停止”, “清除” | `stop` | active target | `dglab_stop` |
| “加/减 N” | `increase` / `decrease` | `delta` | `dglab_increase` / `dglab_decrease` |
| “强度 N，持续 T” | `temporary` | `intensity`, `durationMs` | `dglab_set_temporary` |
| “播放 <波形> T 秒” | `waveform` | compatible waveform, `durationMs` | `dglab_play_waveform` |
| “选 X 的 A 通道” | `select` | unambiguous target | `dglab_select_target` |
| “测试”等项目自定义术语 | — | explicit standard command and parameters | ask; do not send hardware commands |

Do not reserve a generic `test` command. `dglab-kit` has no such API, and individual controller projects may give the word different meanings. A project may document its own explicit command template outside this skill; otherwise ask the user for the target operation and parameters.

## Selection lifecycle

Store a confirmed selection as `{ clientId, slotId, deviceType, channel }` for the current MCP process. Before each non-stop command, echo the selected target and command summary and revalidate it against the latest device state.

Clear the selection on `client-disconnected`, device removal, socket `close`, controller reconnect, `idle_timeout`, relay change, protocol change, or a changed `targetId`. Ask for fresh selection rather than carrying it across those boundaries.
