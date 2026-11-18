import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import config from '../../spider/config.js';
import { commands as aliveCommands } from '../commands/Alive.js';
import { commands } from '../commands/Ping.js';
import { buildStatusButtons } from '../utils/interactiveButtons.js';

test('ping waits for the WhatsApp send acknowledgment before reporting milliseconds', async () => {
  const ping = commands.find((command) => command.name === 'ping');
  const sent = [];
  const relayed = [];
  const msg = { key: { id: 'ping-test', remoteJid: 'test@s.whatsapp.net' } };
  let pingAcknowledged = false;
  const sock = {
    sendMessage: async (...args) => {
      sent.push(args);
      if (sent.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        pingAcknowledged = true;
      }
      return { key: { id: `ping-response-${sent.length}`, remoteJid: 'test@s.whatsapp.net', fromMe: true } };
    },
    relayMessage: async (...args) => {
      assert.equal(pingAcknowledged, true, 'Pong was relayed before the Pinging message was acknowledged');
      relayed.push(args);
      return { key: { id: `ping-response-${sent.length}`, remoteJid: 'test@s.whatsapp.net', fromMe: true } };
    },
  };

  assert.deepEqual(ping.aliases, ['latency', 'speed']);
  await ping.execute({ sock, from: 'test@s.whatsapp.net', msg });

  assert.equal(sent.length, 1);
  assert.equal(relayed.length, 1);
  assert.equal(sent[0][1].text, 'Pinging...');
  const pongPayload = JSON.stringify(relayed[0][1].interactiveMessage);
  assert.match(pongPayload, /Pong!/);
  assert.match(pongPayload, /Speed: \d+ ms/);
  assert.match(pongPayload, /uptime/i, 'ping reply should offer the uptime quick action');
  assert.match(pongPayload, /WhatsApp Channel/);
  const latency = Number(pongPayload.match(/Speed: (\d+) ms/)[1]);
  assert.ok(latency >= 25, `expected the acknowledged send duration to be included, got ${latency} ms`);
  assert.ok(latency < 1000, `expected a reasonable mocked send latency, got ${latency} ms`);
  assert.equal(sent[0][2].quoted, msg);
  assert.equal(relayed[0][2].additionalNodes[0].tag, 'biz');
});

test('status buttons provide reciprocal quick actions and the configured channel link', () => {
  const uptimeButtons = buildStatusButtons('uptime', '⏱️ Uptime');
  const pingButtons = buildStatusButtons('ping', '⚡ Ping');

  assert.equal(uptimeButtons[0].name, 'quick_reply');
  assert.equal(JSON.parse(uptimeButtons[0].buttonParamsJson).id, `${config.PREFIXES?.[0] || '.'}uptime`);
  assert.equal(JSON.parse(uptimeButtons[0].buttonParamsJson).display_text, '⏱️ Uptime');
  assert.equal(pingButtons[0].name, 'quick_reply');
  assert.equal(JSON.parse(pingButtons[0].buttonParamsJson).id, `${config.PREFIXES?.[0] || '.'}ping`);
  assert.equal(JSON.parse(pingButtons[0].buttonParamsJson).display_text, '⚡ Ping');
  assert.equal(JSON.parse(uptimeButtons[1].buttonParamsJson).url, config.CHANNEL_URL);
  assert.equal(JSON.parse(pingButtons[1].buttonParamsJson).url, config.CHANNEL_URL);
});

test('uptime response uses the reference-style ping and channel buttons', async () => {
  const uptime = commands.find((command) => command.name === 'uptime');
  const relayed = [];
  const sock = {
    relayMessage: async (...args) => {
      relayed.push(args);
      return { key: { id: 'uptime-response', remoteJid: 'test@s.whatsapp.net', fromMe: true } };
    },
  };

  await uptime.execute({ sock, from: 'test@s.whatsapp.net', msg: { key: { id: 'uptime-test' } } });

  assert.equal(relayed.length, 1);
  const response = JSON.stringify(relayed[0][1].interactiveMessage);
  assert.match(response, /UPTIME/);
  assert.match(response, /ping/i);
  assert.match(response, /WhatsApp Channel/);
});

test('alive response keeps its status details and adds a ping quick action', async () => {
  const alive = aliveCommands.find((command) => command.name === 'alive');
  const sent = [];
  const relayed = [];
  const sock = {
    sendMessage: async (...args) => {
      sent.push(args);
      return { key: { id: 'alive-checking', remoteJid: 'test@s.whatsapp.net', fromMe: true } };
    },
    relayMessage: async (...args) => {
      relayed.push(args);
      return { key: { id: 'alive-status', remoteJid: 'test@s.whatsapp.net', fromMe: true } };
    },
  };

  await alive.execute({ sock, from: 'test@s.whatsapp.net', msg: { key: { id: 'alive-test' } } });

  assert.equal(sent.length, 1);
  assert.equal(relayed.length, 1);
  const status = relayed[0][1].interactiveMessage;
  assert.match(status.body.text, /UP|online|alive/i);
  assert.match(status.body.text, /uptime/i);
  assert.match(status.body.text, /ping/i);
  assert.match(status.body.text, /RAM|memory/i);
  const buttons = status.nativeFlowMessage.buttons;
  assert.equal(buttons[0].name, 'quick_reply');
  assert.equal(JSON.parse(buttons[0].buttonParamsJson).id, `${config.PREFIXES?.[0] || '.'}ping`);
  assert.equal(JSON.parse(buttons[1].buttonParamsJson).url, config.CHANNEL_URL);
});

test('live dispatcher restores the ping reaction without awaiting it', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  assert.match(source, /if\(_0x836db9==='ping'\)\{try\{Promise\.resolve\(sock\[_0x541605\(0x74\)\]/);
  assert.match(source, /interactiveResponseMessage/);
  assert.match(source, /nativeFlowResponseMessage/);
  assert.match(source, /templateButtonReplyMessage/);
  assert.match(source, /'text':'🧪'/);
});

test('uptime remains registered with the runtime alias', () => {
  const uptime = commands.find((command) => command.name === 'uptime');
  assert.ok(uptime);
  assert.deepEqual(uptime.aliases, ['runtime']);
});
