# V4 WebSocket and HTTP transport

Read this file when the user selects `ws`, `http`, or leaves transport unspecified.

## Routing rules

| Request | `auto` | Explicit `ws` | Explicit `http` |
| --- | --- | --- | --- |
| Connect, pair, generate QR, receive events, or discover devices | WebSocket | WebSocket | Explain that HTTP cannot perform it; keep WebSocket |
| One V4 `device.op` or `device.op.clear` after a verified pairing | HTTP when eligible | WebSocket | HTTP |
| V3 command | WebSocket | WebSocket | Reject; V3 has no HTTP API |

HTTP is eligible only when all conditions hold: the V4 controller WebSocket is still live, `connect()` returned a nonempty `secret`, the target APP is still attached, and an HTTP endpoint is known. In `auto`, fall back to WebSocket only when HTTP is unavailable before dispatch; after an HTTP request is sent, report its HTTP result and do not repeat it over WebSocket. An explicit `http` request never silently falls back.

Keep the controller WebSocket connected while using HTTP. The server binds `secret` to that live controller connection; a close, `idle_timeout`, reconnection, relay change, or changed `targetId` invalidates the secret and all HTTP capability.

## Endpoint selection

For the bundled V4 server, post to `<http-origin>/v4/message` (the server also accepts `/message`). Map a plain relay origin only when it has the standard deployment shape:

- `ws://host:9998` → `http://host:9998/v4/message`
- `wss://host` → `https://host/v4/message`

For a custom relay or reverse proxy, require an explicit HTTP endpoint instead of guessing from the WebSocket path.

## HTTP request contract

The V4 server requires a `POST` request with `apikey` or `x-apikey` set to the controller's `secret`. Use a unique `reqId` and send a V4 RPC request in the message envelope:

```ts
const response = await fetch(httpEndpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    apikey: secret,
  },
  body: JSON.stringify({
    type: 'message',
    clientId,
    data: {
      t: 'req',
      reqId: crypto.randomUUID(),
      m: 'device.op',
      data: operate,
    },
  }),
});

const payload = await response.json();
if (!response.ok || payload.ok !== true) {
  throw new Error(payload.error ?? `HTTP ${response.status}`);
}
```

Use the same V4 RPC methods and operation data as the SDK's WebSocket methods. `dglab-kit` remains the source for V4 enums, waveform data, device state, and WebSocket lifecycle; its current high-level methods send through WebSocket, so the HTTP envelope must follow this relay contract.

HTTP waits for the target APP RPC response. It cannot subscribe to `devices.snapshot`, `devices.patch`, `slots.patch`, `custom.action`, or connection events; maintain those through WebSocket. Handle `401` as stale/invalid secret, `404` as a missing APP/endpoint, `409` as a duplicate `reqId`, and `504` as a timeout or disconnect.
