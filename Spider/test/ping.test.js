import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commands } from '../commands/Ping.js';

test('ping waits for the WhatsApp send acknowledgment before reporting milliseconds', async () => {
  const ping = commands.find((command) => command.name === 'ping');
  const sent = [];
  const msg = { key: { id: 'ping-test', remoteJid: 'test@s.whatsapp.net' } };
  let pingAcknowledged = false;
  const sock = {
    sendMessage: async (...args) => {
      sent.push(args);
      if (sent.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        pingAcknowledged = true;
      } else {
        assert.equal(pingAcknowledged, true, 'Pong was sent before the Pinging message was acknowledged');
      }
      return { key: { id: `ping-response-${sent.length}`, remoteJid: 'test@s.whatsapp.net', fromMe: true } };
    },
  };

  assert.deepEqual(ping.aliases, ['latency', 'speed']);
  await ping.execute({ sock, from: 'test@s.whatsapp.net', msg });

  assert.equal(sent.length, 2);
  assert.equal(sent[0][1].text, 'Pinging...');
  assert.match(sent[1][1].text, /Pong!/);
  assert.match(sent[1][1].text, /Speed: \d+ ms/);
  const latency = Number(sent[1][1].text.match(/Speed: (\d+) ms/)[1]);
  assert.ok(latency >= 25, `expected the acknowledged send duration to be included, got ${latency} ms`);
  assert.ok(latency < 1000, `expected a reasonable mocked send latency, got ${latency} ms`);
  assert.equal(sent[0][2].quoted, msg);
  assert.equal(sent[1][2].quoted, msg);
});

test('live dispatcher restores the ping reaction without awaiting it', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  assert.match(source, /if\(_0x836db9==='ping'\)\{try\{Promise\.resolve\(sock\[_0x541605\(0x74\)\]/);
  assert.match(source, /'text':'🧪'/);
});

test('uptime remains registered with the runtime alias', () => {
  const uptime = commands.find((command) => command.name === 'uptime');
  assert.ok(uptime);
  assert.deepEqual(uptime.aliases, ['runtime']);
});
