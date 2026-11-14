import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getMessageForRetry,
  installMessageRetryStore,
  rememberMessage,
} from '../../spider/anti.js';

const groupA = '120363000000000001@g.us';
const groupB = '120363000000000002@g.us';

test('retry cache returns original content by remote chat and message ID', async () => {
  const sharedId = `retry-${Date.now()}-${Math.random()}`;
  const inbound = { conversation: 'incoming group content' };
  const outbound = { extendedTextMessage: { text: 'outgoing bot content' } };

  assert.equal(rememberMessage({ key: { remoteJid: groupA, id: sharedId, fromMe: false }, message: inbound }), true);
  assert.equal(rememberMessage({ key: { remoteJid: groupB, id: sharedId, fromMe: true }, message: outbound }), true);

  assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id: sharedId }), inbound);
  assert.deepEqual(await getMessageForRetry({ remoteJid: groupB, id: sharedId }), outbound);
  assert.equal(await getMessageForRetry({ remoteJid: '120363000000000003@g.us', id: sharedId }), undefined);
  assert.equal(await getMessageForRetry({ id: `missing-${sharedId}` }), undefined);
});

test('retry cache immediately captures sendMessage and relayMessage payloads', async () => {
  const id = `send-${Date.now()}-${Math.random()}`;
  const relayedId = `relay-${Date.now()}-${Math.random()}`;
  const sentContent = { conversation: 'sent with sendMessage' };
  const relayedContent = { extendedTextMessage: { text: 'sent with relayMessage' } };
  const sock = {
    sendMessage: async (jid) => ({ key: { remoteJid: jid, id, fromMe: true }, message: sentContent }),
    relayMessage: async () => ({ key: { remoteJid: groupA, id: relayedId, fromMe: true } }),
  };

  assert.equal(installMessageRetryStore(sock), true);
  assert.equal(installMessageRetryStore(sock), true, 'install should be idempotent');
  await sock.sendMessage(groupA, sentContent);
  await sock.relayMessage(groupA, relayedContent, { messageId: relayedId });

  assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id }), sentContent);
  assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id: relayedId }), relayedContent);
});

test('serializes concurrent sends per chat while keeping different chats parallel', async () => {
  const events = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sock = {
    sendMessage: async (jid, message) => {
      events.push(`start:${jid}:${message.text}`);
      await wait(5);
      events.push(`end:${jid}:${message.text}`);
      return { key: { remoteJid: jid, id: `${jid}-${message.text}`, fromMe: true }, message };
    },
  };

  installMessageRetryStore(sock);
  await Promise.all([
    sock.sendMessage(groupA, { text: 'one' }),
    sock.sendMessage(groupA, { text: 'two' }),
    sock.sendMessage(groupB, { text: 'other' }),
  ]);

  assert.deepEqual(events.slice(0, 3), [
    `start:${groupA}:one`,
    `start:${groupB}:other`,
    `end:${groupA}:one`,
  ]);
  assert.equal(events.indexOf(`start:${groupA}:two`) > events.indexOf(`end:${groupA}:one`), true);
});

test('live Baileys socket wires getMessage and caches upserted and own-sent messages', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  assert.match(source, /'getMessage':getMessageForRetry/);
  assert.match(source, /'emitOwnEvents':!!\[\]/);
  assert.match(source, /'shouldSyncHistoryMessage':\(\)=>!!\[\]/);
  assert.match(source, /installMessageRetryStore\(sock\)/);
  assert.match(source, /messaging-history\.set/);
  assert.match(source, /rememberMessage\(_0x16a3b2\);/);
});
