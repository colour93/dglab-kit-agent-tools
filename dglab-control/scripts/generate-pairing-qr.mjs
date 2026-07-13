#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';

const DEFAULT_RELAY = 'wss://ws.dungeon-lab.cn/';

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage: bun scripts/generate-pairing-qr.mjs --target-id <id> [--version v4|v3] [--server <ws-url>] [--output <png-path>] [--terminal]');
  process.exit(1);
}

function optionsFrom(argv) {
  const options = { version: 'v4', server: DEFAULT_RELAY, output: 'dglab-pairing.png', terminal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith('--')) usage(`Unexpected argument: ${option}`);
    const name = option.slice(2);
    if (name === 'terminal') {
      options.terminal = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for --${name}`);
    if (!(name in options) && name !== 'target-id') usage(`Unknown option: --${name}`);
    options[name === 'target-id' ? 'targetId' : name] = value;
    index += 1;
  }
  if (!options.targetId?.trim()) usage('--target-id is required');
  if (!['v3', 'v4'].includes(options.version)) usage('--version must be v3 or v4');
  return options;
}

function pairingUrls({ version, server, targetId }) {
  let relay;
  try {
    relay = new URL(server);
  } catch {
    usage('--server must be a valid ws:// or wss:// URL');
  }
  if (!['ws:', 'wss:'].includes(relay.protocol)) usage('--server must use ws:// or wss://');

  if (version === 'v4') {
    relay.searchParams.set('tid', targetId);
    const appSocketUrl = relay.toString();
    return {
      appSocketUrl,
      qrPayload: `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appSocketUrl)}`,
    };
  }

  relay.search = '';
  relay.hash = '';
  relay.pathname = `${relay.pathname.replace(/\/+$/, '')}/${encodeURIComponent(targetId)}`;
  const appSocketUrl = relay.toString();
  return {
    appSocketUrl,
    qrPayload: `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${appSocketUrl}`,
  };
}

const options = optionsFrom(process.argv.slice(2));
const { appSocketUrl, qrPayload } = pairingUrls(options);
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await QRCode.toFile(output, qrPayload, {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 768,
});

console.log(`QR image: ${output}`);
console.log(`APP socket URL: ${appSocketUrl}`);
console.log(`QR payload: ${qrPayload}`);

if (options.terminal) {
  console.log('Terminal QR:');
  qrcodeTerminal.generate(qrPayload, { small: true }, (code) => process.stdout.write(`${code}\n`));
}
