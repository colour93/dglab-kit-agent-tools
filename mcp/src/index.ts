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

function envInteger(name: string, fallback: number, min: number, max: number): number {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const controller = new DglabController({
  relay: process.env.DGLAB_RELAY ?? DEFAULT_RELAY,
  limits: {
    delta: envInteger('DGLAB_MAX_DELTA', DEFAULT_LIMITS.delta, 1, DEFAULT_LIMITS.delta),
    intensity: envInteger('DGLAB_MAX_INTENSITY', DEFAULT_LIMITS.intensity, 0, DEFAULT_LIMITS.intensity),
    durationMs: envInteger('DGLAB_MAX_DURATION_MS', DEFAULT_LIMITS.durationMs, 0, DEFAULT_LIMITS.durationMs),
  },
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
  'dglab_connect',
  {
    title: 'Connect and pair DG-LAB',
    description: 'Connect the local controller to a V4 relay and return a fresh APP pairing QR code. Reuses the current live connection when possible.',
    inputSchema: { relay: z.string().url().optional() },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  safe(async ({ relay }: { relay?: string }) => {
    const { qrPngBase64, ...connection } = await controller.connect(relay);
    return {
      content: [
        { type: 'text', text: JSON.stringify(connection, null, 2) },
        { type: 'image', data: qrPngBase64, mimeType: 'image/png' },
      ],
      structuredContent: connection as Record<string, unknown>,
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
  safe(async () => textResult(controller.status())),
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
    description: 'Clear all channels touched by this MCP process, invalidate the selection, and close the relay connection.',
    inputSchema: {},
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  safe(async () => textResult(await controller.disconnect())),
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await controller.disconnect('mcp_shutdown');
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
