# dglab-kit implementation patterns

Use these patterns selectively; adapt names and state management to the target project.

## Contents

- [Controller ownership](#controller-ownership)
- [Pairing and discovery](#pairing-and-discovery)
- [Selection and validation](#selection-and-validation)
- [Scheduling and stop priority](#scheduling-and-stop-priority)
- [Cleanup](#cleanup)
- [Framework integration](#framework-integration)

## Controller ownership

Create one controller service per independent relay session. Keep `DglabSocket` and mutable connection state out of UI components, route handlers, and short-lived jobs.

```ts
import { DGLAB_SOCKET_STATE, DglabSocket } from 'dglab-kit';

export class DglabController {
  private socket: InstanceType<typeof DglabSocket> | null = null;
  private selection: Selection | null = null;

  async connect(relayUrl: string) {
    await this.shutdown('reconnect');

    const socket = new DglabSocket({ url: relayUrl });
    this.socket = socket;

    socket.on('client-attached', (clientId) => {
      void socket.requestDevices(clientId).catch((error) => {
        this.report(error);
      });
    });
    socket.on('client-disconnected', (clientId) => {
      if (this.selection?.clientId === clientId) this.selection = null;
    });
    socket.on('devices', (_devices, clientId) => {
      this.revalidateSelection(clientId);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.selection = null;
    });
    socket.on('error', (error) => this.report(error));

    const result = await socket.connect();
    if (socket.state !== DGLAB_SOCKET_STATE.WaitingForPeer) {
      throw new Error('V4 relay handshake did not complete');
    }
    return result;
  }

  private report(error: unknown) {
    // Send a redacted application error to logging/UI infrastructure.
  }

  private revalidateSelection(clientId: string) {
    if (!this.selection || this.selection.clientId !== clientId) return;
    const device = this.socket
      ?.getClient(clientId)
      ?.getDevice(this.selection.slotId);
    if (!device) this.selection = null;
  }
}
```

Do not log `secret`. Guard callbacks with socket identity when reconnect can replace the active instance, so events from an old socket cannot mutate new state.

## Pairing and discovery

Return pairing data separately from the HTTP secret:

```ts
function createPairingUrl(relayUrl: string, targetId: string): string {
  const socketUrl = new URL(relayUrl);
  if (!['ws:', 'wss:'].includes(socketUrl.protocol)) {
    throw new Error('Relay must use ws:// or wss://');
  }
  socketUrl.searchParams.set('tid', targetId);

  const pairingUrl = new URL('https://dungeon-lab.cn/s/');
  pairingUrl.searchParams.set('v', '1');
  pairingUrl.searchParams.set('action', 'socket');
  pairingUrl.searchParams.set('url', socketUrl.toString());
  return pairingUrl.toString();
}
```

Use an APP-reachable relay address. A phone generally cannot reach a server advertised as `127.0.0.1` on another machine. Do not silently start or expose a network listener as part of an SDK integration.

On `client-attached`, call `requestDevices(clientId)`. Present `socket.clients` grouped by `clientId`; present each client's devices by `slotId`. Do not select `devices[0]` in reusable or multi-user code.

## Selection and validation

Represent the target as one atomic value:

```ts
type Selection = {
  clientId: string;
  slotId: string;
  channel: 'A' | 'B';
};
```

Resolve it immediately before each command. Require the APP and device still to exist. Map the channel to `V4Channel` only after validating it.

Before output commands:

1. Require finite integer inputs.
2. Apply configured maximum delta, intensity, duration, and frame count.
3. Inspect current `props` and `slotState` for connection, mute, channel availability, overheat, damage, and blocking.
4. Combine the configured intensity ceiling with reported `intensityMax`.
5. Reject incompatible device/operation combinations.

If the product has no approved policy yet, an intentionally conservative starting point is a maximum relative delta of `5`, temporary intensity of `20`, duration of `5000 ms`, and `50` custom frames. Keep these values configurable and label them as an application policy for product-owner review, not SDK limits.

Keep hard failures and warnings distinct. Overheat, output damage, and blocked channels should fail. A disconnected device, empty slot, mute, or missing OVC accessory should normally produce a visible warning and follow product policy.

Do not use arbitrary absolute intensity through raw RPC: V4 `SetIntensity` accepts only `0`; use `resetIntensity()` for it. Use bounded relative changes or time-limited intensity for nonzero output.

## Scheduling and stop priority

The remote task scheduler has its own queues, but applications should also prevent local races. Serialize normal commands by `clientId + slotId + channel`. Maintain a generation counter for each key; a stop increments the counter so locally queued commands cannot run afterward.

```ts
private queues = new Map<string, Promise<unknown>>();
private generations = new Map<string, number>();

private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const generation = this.generations.get(key) ?? 0;
  const previous = this.queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => {
    if ((this.generations.get(key) ?? 0) !== generation) {
      throw new Error('Command cancelled by stop');
    }
    return operation();
  });
  this.queues.set(key, current);
  void current.finally(() => {
    if (this.queues.get(key) === current) this.queues.delete(key);
  }).catch(() => undefined);
  return current;
}

private cancelQueued(key: string): void {
  this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
}
```

For stop:

1. Increment the local generation first.
2. Call `clearOperate(clientId, { slotId, channel })` immediately rather than placing it behind the normal queue.
3. Remove that target from the touched-target set after a successful clear.

Use `immediate: true` for relative, temporary-intensity, or waveform calls only when replacement matches product semantics. It does not replace the need for a stop path.

## Cleanup

Track targets after starting output-affecting work. On explicit shutdown or reconnect:

1. Cancel locally queued commands for every touched target.
2. Best-effort `clearOperate` for targets whose APP remains attached.
3. Clear selection and in-memory secrets/pairing state.
4. Remove the active socket reference before disposal so late callbacks are ignored.
5. Call `socket.destroy(1000, reason)`.

Also install the framework's appropriate process/page lifecycle hook. Do not rely on abrupt process termination to deliver asynchronous clear commands.

## Framework integration

- **Node/Bun service:** keep the controller in application scope; inject it into handlers. Keep the HTTP `secret` only in server memory or an approved secret store.
- **React/Next.js:** create the browser controller outside render or behind a stable provider. Never recreate it on state changes. If the SDK must run server-side, stream redacted state to the UI rather than the socket secret.
- **Browser/custom runtime:** use manual transport only when the built-in WebSocket cannot be used. Forward open, message, close, and error events and remove transport listeners on disposal.
- **Serverless:** avoid a persistent WebSocket controller in request-scoped functions. Use a durable worker/service for eventful sessions, or use authenticated HTTP RPC only when push events and live inventory are not needed.
