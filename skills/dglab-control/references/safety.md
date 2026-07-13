# Device command safety policy

Apply this policy after intent normalization and before every hardware command.

## Default bounds

Use these conservative defaults unless the user explicitly configures stricter limits:

| Value | Default |
| --- | --- |
| Maximum relative change per command | `5` |
| Maximum temporary intensity | `20` |
| Maximum waveform or temporary duration | `5,000 ms` |

Require finite integers. Require nonnegative values for temporary intensity and duration, and a positive magnitude for a relative change. Reject out-of-policy values instead of silently clamping them; ask the user to send a bounded value.

The SDK does not define a universal device maximum. When the selected channel reports `slotState.channelA.intensityMax` or `slotState.channelB.intensityMax`, set the effective maximum to the smaller of that reported value and the configured maximum. If a command needs an absolute or temporary intensity and the effective maximum is unavailable, ask the user to configure a conservative limit.

## Execution checks

1. Verify the session target is live and the channel is eligible.
2. Validate type compatibility, bounds, and duration.
3. State `APP`, device name/type, `slotId`, channel, and normalized command before execution.
4. Call the corresponding MCP tool; do not bypass its validation with handcrafted SDK or protocol calls.
5. Await and handle command completion or rejection. A direct stop/clear request bypasses normal confirmation and takes priority.

On a normal shutdown, call `dglab_disconnect`; it clears touched channels while the socket is live before disconnecting. If a close has already occurred, do not send a new command; invalidate the selection and require a new pairing.
