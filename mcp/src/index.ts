#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DEFAULT_LIMITS,
  DEFAULT_RELAY,
  DglabController,
  type TargetInput,
} from './controller.ts';
import {
  EmbeddedRelayManager,
  type EmbeddedRelayConfig,
} from './relay/manager.ts';

type RelayMode = 'remote' | 'embedded';

type ConnectInput = EmbeddedRelayConfig & {
  mode?: RelayMode;
  relay?: string;
};

type ControllerConnection = Awaited<ReturnType<DglabController['connect']>>;

function envInteger(name: string, fallback: number, min: number, max: number): number {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function envBoolean(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function relayMode(value: string | undefined): RelayMode {
  if (value === undefined || value === 'remote') return 'remote';
  if (value === 'embedded') return 'embedded';
  throw new Error('DGLAB_RELAY_MODE must be remote or embedded');
}

const defaultRelayMode = relayMode(process.env.DGLAB_RELAY_MODE);

const controller = new DglabController({
  relay: process.env.DGLAB_RELAY ?? DEFAULT_RELAY,
  limits: {
    delta: envInteger('DGLAB_MAX_DELTA', DEFAULT_LIMITS.delta, 1, DEFAULT_LIMITS.delta),
    intensity: envInteger('DGLAB_MAX_INTENSITY', DEFAULT_LIMITS.intensity, 0, DEFAULT_LIMITS.intensity),
    durationMs: envInteger('DGLAB_MAX_DURATION_MS', DEFAULT_LIMITS.durationMs, 0, DEFAULT_LIMITS.durationMs),
  },
});

const embeddedRelay = new EmbeddedRelayManager({
  bindHost: process.env.DGLAB_EMBEDDED_BIND_HOST ?? '127.0.0.1',
  port: envInteger('DGLAB_EMBEDDED_PORT', 9998, 1, 65_535),
  controllerUrl: process.env.DGLAB_EMBEDDED_CONTROLLER_URL,
  advertisedUrl: process.env.DGLAB_EMBEDDED_ADVERTISED_URL,
  allowNetworkExposure: envBoolean('DGLAB_EMBEDDED_ALLOW_NETWORK_EXPOSURE'),
});

const server = new McpServer(
  { name: 'dglab-kit', version: '0.1.0' },
  {
    instructions: 'Connect and pair first, inspect status, explicitly select a target, then send bounded commands. Stop requests take priority. Never reveal relay secrets.',
  },
);

function textResult<T extends object>(value: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function safe<TInput extends object>(handler: (input: TInput) => Promise<CallToolResult>) {
  return async (input: TInput): Promise<CallToolResult> => {
    try {
      return await handler(input);
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  };
}

server.registerTool(
  'dglab_list_relay_addresses',
  {
    title: 'List embedded relay addresses',
    description: 'List loopback and private IPv4 address candidates for an embedded relay. A phone normally needs a LAN address, not 127.0.0.1.',
    inputSchema: { port: z.number().int().min(1).max(65_535).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  safe(async ({ port }: { port?: number }) => textResult(embeddedRelay.listAddresses(port))),
);

server.registerTool(
  'dglab_start_relay',
  {
    title: 'Start embedded V4 relay',
    description: 'Start the Bun-only embedded V4 relay. Non-loopback binding requires allowNetworkExposure=true and an explicit advertisedUrl reachable by the APP.',
    inputSchema: {
      bindHost: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65_535).optional(),
      controllerUrl: z.string().url().optional(),
      advertisedUrl: z.string().url().optional(),
      allowNetworkExposure: z.boolean().optional(),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  safe(async (input: EmbeddedRelayConfig) => {
    await controller.disconnect('embedded_relay_start');
    return textResult(await embeddedRelay.start(input));
  }),
);

server.registerTool(
  'dglab_stop_relay',
  {
    title: 'Stop embedded V4 relay',
    description: 'Clear and disconnect the controller, then stop the embedded relay and close its listeners.',
    inputSchema: {},
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  safe(async () => {
    const connection = await controller.disconnect('embedded_relay_stop');
    const relay = await embeddedRelay.stop();
    return textResult({ connection, relay });
  }),
);

server.registerTool(
  'dglab_connect',
  {
    title: 'Connect and pair DG-LAB',
    description: 'Connect through a remote V4 relay or start/use the embedded Bun relay, then return an APP pairing QR. Network exposure must be explicitly allowed.',
    inputSchema: {
      mode: z.enum(['remote', 'embedded']).optional(),
      relay: z.string().url().optional(),
      bindHost: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65_535).optional(),
      controllerUrl: z.string().url().optional(),
      advertisedUrl: z.string().url().optional(),
      allowNetworkExposure: z.boolean().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  safe(async (input: ConnectInput) => {
    const mode = input.mode ?? defaultRelayMode;
    let connectionResult: ControllerConnection;
    if (mode === 'remote') {
      if (embeddedRelay.status().running) {
        await controller.disconnect('switch_to_remote_relay');
        await embeddedRelay.stop();
      }
      connectionResult = await controller.connect(input.relay ?? process.env.DGLAB_RELAY ?? DEFAULT_RELAY);
    } else {
      const hasOverride = input.bindHost !== undefined
        || input.port !== undefined
        || input.controllerUrl !== undefined
        || input.advertisedUrl !== undefined
        || input.allowNetworkExposure !== undefined;
      if (!embeddedRelay.status().running || hasOverride) {
        await controller.disconnect('embedded_relay_prepare');
        await embeddedRelay.start(input);
      }
      const urls = embeddedRelay.connectionUrls();
      connectionResult = await controller.connect(urls.controllerUrl, urls.advertisedUrl);
    }
    const { qrPngBase64, ...connection } = connectionResult;
    return {
      content: [
        { type: 'text', text: JSON.stringify({ mode, connection, embeddedRelay: embeddedRelay.status() }, null, 2) },
        { type: 'image', data: qrPngBase64, mimeType: 'image/png' },
      ],
      structuredContent: { mode, connection, embeddedRelay: embeddedRelay.status() },
    };
  }),
);

server.registerTool(
  'dglab_status',
  {
    title: 'Inspect DG-LAB session',
    description: 'Return the live relay state, attached APPs, devices, compatible waveforms, active selection, limits, and recent events. Does not expose the HTTP secret.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  safe(async () => textResult({
    defaultRelayMode,
    controller: controller.status(),
    embeddedRelay: embeddedRelay.status(),
  })),
);

server.registerTool(
  'dglab_select_target',
  {
    title: 'Select DG-LAB target',
    description: 'Select an exact attached APP, device slot, and channel for later control calls. Never infer a device from list order.',
    inputSchema: {
      clientId: z.string().min(1),
      slotId: z.string().min(1),
      channel: z.enum(['A', 'B']),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  safe(async (input: Required<TargetInput>) => textResult(controller.select(input))),
);

server.registerTool(
  'dglab_increase',
  {
    title: 'Increase DG-LAB intensity',
    description: 'Increase the selected channel by an explicit bounded delta. Commands for the same channel are serialized.',
    inputSchema: { delta: z.number().int().min(1).max(controller.limits.delta) },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  safe(async ({ delta }: { delta: number }) => textResult(await controller.increase(delta))),
);

server.registerTool(
  'dglab_decrease',
  {
    title: 'Decrease DG-LAB intensity',
    description: 'Decrease the selected channel by an explicit bounded delta. Commands for the same channel are serialized.',
    inputSchema: { delta: z.number().int().min(1).max(controller.limits.delta) },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  safe(async ({ delta }: { delta: number }) => textResult(await controller.decrease(delta))),
);

server.registerTool(
  'dglab_set_temporary',
  {
    title: 'Set temporary DG-LAB intensity',
    description: 'Set a bounded temporary intensity on the selected channel. It returns to zero when the task ends.',
    inputSchema: {
      intensity: z.number().int().min(0).max(controller.limits.intensity),
      durationMs: z.number().int().min(0).max(controller.limits.durationMs),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  safe(async ({ intensity, durationMs }: { intensity: number; durationMs: number }) => (
    textResult(await controller.temporary(intensity, durationMs))
  )),
);

server.registerTool(
  'dglab_play_waveform',
  {
    title: 'Play DG-LAB waveform',
    description: 'Play a named compatible waveform on the selected channel for a bounded duration. Read dglab_status for compatible names.',
    inputSchema: {
      name: z.string().min(1),
      durationMs: z.number().int().min(0).max(controller.limits.durationMs),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  safe(async ({ name, durationMs }: { name: string; durationMs: number }) => (
    textResult(await controller.waveform(name, durationMs))
  )),
);

server.registerTool(
  'dglab_stop',
  {
    title: 'Stop DG-LAB channel',
    description: 'Immediately cancel queued work and clear operations for the active target. An explicit complete target may be provided when no selection exists.',
    inputSchema: {
      clientId: z.string().min(1).optional(),
      slotId: z.string().min(1).optional(),
      channel: z.enum(['A', 'B']).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  safe(async (input: TargetInput) => textResult(await controller.stop(input))),
);

server.registerTool(
  'dglab_disconnect',
  {
    title: 'Disconnect DG-LAB controller',
    description: 'Clear touched channels and disconnect. The embedded relay is stopped by default; set keepEmbeddedRelay=true to leave it listening.',
    inputSchema: { keepEmbeddedRelay: z.boolean().optional() },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  safe(async ({ keepEmbeddedRelay }: { keepEmbeddedRelay?: boolean }) => {
    const connection = await controller.disconnect();
    const relay = keepEmbeddedRelay ? embeddedRelay.status() : await embeddedRelay.stop();
    return textResult({ connection, relay });
  }),
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await controller.disconnect('mcp_shutdown');
  await embeddedRelay.stop();
  await server.close();
}

process.once('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});
process.once('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
process.stdin.once('end', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
