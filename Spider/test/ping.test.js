import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commands } from '../commands/Ping.js';

test('ping sends one immediate Pong response without a separate Pinging roundtrip', async () => {
  const ping = commands.find((command) => command.name === 'ping');
  const sent = [];
  const msg = { key: { id: 'ping-test', remoteJid: 'test@s.whatsapp.net' } };
  const sock = {
    sendMessage: async (...args) => {
      sent.push(args);
      return { key: { id: 'pong-test', remoteJid: 'test@s.whatsapp.net', fromMe: true } };
    },
  };

  assert.deepEqual(ping.aliases, ['latency', 'speed']);
  await ping.execute({ sock, from: 'test@s.whatsapp.net', msg });

  assert.equal(sent.length, 1);
  assert.match(sent[0][1].text, /Pong!/);
  assert.doesNotMatch(sent[0][1].text, /Pinging/);
  assert.equal(sent[0][2].quoted, msg);
});

test('live command dispatcher skips the awaited reaction for ping and its aliases', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  assert.match(source, /_0x836db9!=='ping'\)await sock\[_0x541605\(0x74\)\]/);
});

test('uptime remains registered with the runtime alias', () => {
  const uptime = commands.find((command) => command.name === 'uptime');
  assert.ok(uptime);
  assert.deepEqual(uptime.aliases, ['runtime']);
});
