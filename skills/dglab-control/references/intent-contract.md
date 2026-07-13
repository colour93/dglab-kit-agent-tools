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

Resolve an explicit APP, device slot, or channel from the message first. Otherwise use the active session selection. If neither is available or it is stale, ask the user to select from the discovered slots; never infer from ordering.

## Intent mapping

| User wording | Normalized command | Required values | MCP tool |
| --- | --- | --- | --- |
| “停止”, “清除” | `stop` | active target | `dglab_stop` |
| “加/减 N” | `increase` / `decrease` | `delta` | `dglab_increase` / `dglab_decrease` |
| “强度 N，持续 T” | `temporary` | `intensity`, `durationMs` | `dglab_set_temporary` |
| “播放 <波形> T 秒” | `waveform` | compatible waveform, `durationMs` | `dglab_play_waveform` |
| “选 X 的 A 通道” | `select` | unambiguous target | `dglab_select_target` |
| “测试”等项目自定义术语 | the explicit command template defined earlier in the active interaction | values from that template | mapped bounded MCP tool(s) |

Do not reserve a global generic `test` command. If the user explicitly defines “测试” or another alias as a fully specified bounded command in the active interaction, retain that mapping for the interaction and execute it when invoked without asking the user to repeat its parameters. Otherwise ask for the target operation and parameters.

## Selection lifecycle

Store a selected target as `{ clientId, slotId, deviceType, channel }` for the current MCP process. Before each non-stop command, echo the selected target, command summary, and warning-only device states, then execute immediately. Do not turn this notice into another confirmation step.

Clear the selection on `client-disconnected`, device removal, socket `close`, controller reconnect, `idle_timeout`, relay change, protocol change, or a changed `targetId`. Ask for fresh selection rather than carrying it across those boundaries.
