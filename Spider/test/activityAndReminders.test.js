import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createGroupActivityStore,
  defaultGroupActivityStore,
  formatRelativeTime,
} from '../../spider/utils/groupActivityStore.js';
import {
  createReminderScheduler,
  createReminderStore,
  defaultReminderStore,
  extractDurationAndMessage,
  formatDuration,
  parseReminderDuration,
} from '../../spider/utils/reminderStore.js';
import { reloadCommandsFromDisk } from '../../spider/utils/runtimeControl.js';

function createTempFilePath(prefix, filename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, filePath: path.join(dir, filename) };
}

test('groupActivityStore tracks counts, merges LID/PN identities, ranks active users, detects ghosts, and persists', () => {
  const { dir, filePath } = createTempFilePath('spider-activity-', 'activity.json');
  let nowMs = 1_700_000_000_000;
  const groupJid = '120363000000111111@g.us';

  try {
    const store = createGroupActivityStore(filePath, {
      flushDebounceMs: 1000,
      now: () => nowMs,
    });
    const lidToPhoneMap = new Map();

    // User 1 sends 2 messages as LID first, then 1 message after LID->PN mapping is known
    store.recordMessage({
      groupJid,
      senderJid: '100001@lid',
      senderCandidates: ['100001@lid'],
      pushName: 'Alice',
      timestampMs: nowMs - 2 * 86_400_000,
    });
    store.recordMessage({
      groupJid,
      senderJid: '100001@lid',
      senderCandidates: ['100001@lid'],
      pushName: 'Alice',
      timestampMs: nowMs - 86_400_000,
    });

    lidToPhoneMap.set('100001', '254711111111');
    store.recordMessage({
      groupJid,
      senderJid: '254711111111@s.whatsapp.net',
      senderCandidates: ['254711111111@s.whatsapp.net', '100001@lid'],
      pushName: 'Alice',
      timestampMs: nowMs - 3600_000,
      lidToPhoneMap,
    });

    // User 2 sends 1 recent message
    store.recordMessage({
      groupJid,
      senderJid: '254722222222@s.whatsapp.net',
      pushName: 'Bob',
      timestampMs: nowMs - 600_000,
    });

    // User 3 spoke 15 days ago (inactive under 7d threshold)
    store.recordMessage({
      groupJid,
      senderJid: '254733333333@s.whatsapp.net',
      pushName: 'Charlie',
      timestampMs: nowMs - 15 * 86_400_000,
    });

    // Non-group messages should be ignored
    assert.equal(
      store.recordMessage({ groupJid: '254722222222@s.whatsapp.net', senderJid: '254722222222@s.whatsapp.net' }),
      null,
    );

    const rankingAll = store.getActiveRanking(groupJid, { limit: 10 });
    assert.equal(rankingAll.totalMessages, 5);
    assert.equal(rankingAll.trackedMembers, 3);
    assert.equal(rankingAll.entries[0].phone, '254711111111');
    assert.equal(rankingAll.entries[0].count, 3);
    assert.equal(rankingAll.entries[1].phone, '254722222222');
    assert.equal(rankingAll.entries[1].count, 1);

    // Filter last 7 days should exclude Charlie
    const ranking7d = store.getActiveRanking(groupJid, { days: 7, limit: 10 });
    assert.equal(ranking7d.trackedMembers, 2);
    assert.equal(ranking7d.totalMessages, 4);

    // Ghost / inactive detection against live group metadata
    const metadata = {
      id: groupJid,
      subject: 'Squad',
      participants: [
        { id: '254700000001@s.whatsapp.net', admin: 'superadmin' }, // Bot itself
        { id: '254711111111@s.whatsapp.net', lid: '100001@lid', admin: null },
        { id: '254722222222@s.whatsapp.net', admin: null },
        { id: '254733333333@s.whatsapp.net', admin: null }, // 15d old
        { id: '254744444444@s.whatsapp.net', admin: null }, // 0 messages ghost
      ],
    };

    const inactive7d = store.getInactiveMembers(groupJid, {
      metadata,
      days: 7,
      botJids: ['254700000001@s.whatsapp.net'],
      lidToPhoneMap,
    });
    assert.equal(inactive7d.activeCount, 2);
    assert.equal(inactive7d.inactive.length, 2);
    assert.equal(inactive7d.inactive[0].phone, '254744444444');
    assert.equal(inactive7d.inactive[0].count, 0);
    assert.equal(inactive7d.inactive[1].phone, '254733333333');
    assert.equal(inactive7d.inactive[1].count, 1);

    const zeroOnly = store.getInactiveMembers(groupJid, {
      metadata,
      days: 0,
      botJids: ['254700000001@s.whatsapp.net'],
      lidToPhoneMap,
    });
    assert.equal(zeroOnly.inactive.length, 1);
    assert.equal(zeroOnly.inactive[0].phone, '254744444444');

    // Persistence flush & reload
    store.flush();
    const reloaded = createGroupActivityStore(filePath, { now: () => nowMs });
    const reloadedRank = reloaded.getActiveRanking(groupJid);
    assert.equal(reloadedRank.totalMessages, 5);
    assert.equal(reloadedRank.entries[0].count, 3);

    assert.equal(formatRelativeTime(nowMs - 45_000, nowMs), 'just now');
    assert.equal(formatRelativeTime(nowMs - 5 * 60_000, nowMs), '5m ago');
    assert.equal(formatRelativeTime(nowMs - 3 * 3600_000, nowMs), '3h ago');
    assert.equal(formatRelativeTime(nowMs - 4 * 86_400_000, nowMs), '4d ago');

    reloaded.resetGroup(groupJid);
    assert.equal(reloaded.getActiveRanking(groupJid).entries.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reminderStore duration parser, persistence, permissions, and scheduler delivery work reliably', async () => {
  assert.equal(parseReminderDuration('2h'), 2 * 3_600_000);
  assert.equal(parseReminderDuration('1h30m'), 90 * 60_000);
  assert.equal(parseReminderDuration('10s'), 10_000);
  assert.equal(parseReminderDuration('2w'), 14 * 86_400_000);
  assert.equal(parseReminderDuration('invalid'), null);

  assert.deepEqual(extractDurationAndMessage('2h Check deployment'), {
    ok: true,
    reason: null,
    durationMs: 2 * 3_600_000,
    message: 'Check deployment',
  });
  assert.deepEqual(extractDurationAndMessage('1h 30m Deploy backend'), {
    ok: true,
    reason: null,
    durationMs: 90 * 60_000,
    message: 'Deploy backend',
  });
  assert.equal(extractDurationAndMessage('2s Too short').reason, 'too-short');
  assert.equal(extractDurationAndMessage('500d Too far').reason, 'too-long');
  assert.equal(extractDurationAndMessage('hello world').reason, 'invalid-duration');
  assert.equal(formatDuration(5_400_000), '1h 30m');

  const { dir, filePath } = createTempFilePath('spider-remind-', 'reminders.json');
  let nowMs = 1_700_000_000_000;

  try {
    const store = createReminderStore(filePath, { now: () => nowMs });
    const dmChat = '254711111111@s.whatsapp.net';
    const grpChat = '120363000000222222@g.us';

    const add1 = store.addReminder({
      chatJid: dmChat,
      creatorJid: '254711111111@s.whatsapp.net',
      text: 'Call client',
      durationMs: 60_000,
    });
    assert.equal(add1.ok, true);

    const add2 = store.addReminder({
      chatJid: grpChat,
      creatorJid: '254722222222@s.whatsapp.net',
      text: 'Check deployment',
      durationMs: 120_000,
    });
    assert.equal(add2.ok, true);

    // Reload from disk to simulate bot restart
    const restartedStore = createReminderStore(filePath, { now: () => nowMs });
    assert.equal(restartedStore.listReminders({ scope: 'all' }).length, 2);

    // Permission check on deletion: another non-admin user cannot delete add2
    const denied = restartedStore.deleteReminder(add2.reminder.id, {
      chatJid: grpChat,
      actorJid: '254799999999@s.whatsapp.net',
      isGroupAdmin: false,
      isOwner: false,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'forbidden');

    // Disconnected socket should defer reminder delivery without deleting
    nowMs += 65_000;
    const sent = [];
    let connected = false;
    const mockSock = {
      get user() {
        return connected ? { id: '254700000001@s.whatsapp.net' } : null;
      },
      sendMessage: async (jid, payload) => {
        sent.push({ jid, payload });
        return { key: { id: `rem-${sent.length}` } };
      },
    };

    const scheduler = createReminderScheduler({
      store: restartedStore,
      getSock: () => mockSock,
      now: () => nowMs,
    });

    const deferredRes = await scheduler.triggerCheck();
    assert.equal(deferredRes.delivered, 0);
    assert.equal(deferredRes.deferred, 1);
    assert.equal(restartedStore.listReminders({ scope: 'all' }).length, 2);

    // Once connected, due reminder delivers immediately and leaves remaining one intact
    connected = true;
    const deliveredRes = await scheduler.triggerCheck();
    assert.equal(deliveredRes.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, dmChat);
    assert.match(sent[0].payload.text, /Call client/);
    assert.equal(restartedStore.listReminders({ scope: 'all' }).length, 1);

    // Second reminder comes due with group mention
    nowMs += 60_000;
    const secondRes = await scheduler.triggerCheck();
    assert.equal(secondRes.delivered, 1);
    assert.equal(sent[1].jid, grpChat);
    assert.deepEqual(sent[1].payload.mentions, ['254722222222@s.whatsapp.net']);
    assert.match(sent[1].payload.text, /Check deployment/);
    assert.equal(restartedStore.listReminders({ scope: 'all' }).length, 0);

    scheduler.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('new commands (active, inactive, leaderboard, remind, reminders, delremind) load cleanly and execute', async (t) => {
  const repoRoot = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-new-cmds-'));
  t.mock.method(process, 'cwd', () => tmpDir);
  defaultGroupActivityStore.clearCache();
  defaultReminderStore.clearCache();

  const commandsMap = new Map();
  const aliasesMap = new Map();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const stats = await reloadCommandsFromDisk({
      commandsDir: path.join(repoRoot, 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 888001,
    });

    // Verify all 6 canonical commands exist with zero collisions involving them
    for (const name of ['active', 'inactive', 'leaderboard', 'remind', 'reminders', 'delremind']) {
      assert.ok(commandsMap.has(name), `Expected canonical command '${name}' to be loaded`);
      assert.equal(aliasesMap.has(name), false, `Canonical '${name}' must not be shadowed in aliasesMap`);
      assert.equal(
        stats.collisions.some((c) => c.name === name),
        false,
        `Command '${name}' should have zero loader collisions`,
      );
    }
    assert.equal(aliasesMap.get('listonline'), 'online');
    assert.equal(aliasesMap.get('lb'), 'leaderboard');
    assert.equal(aliasesMap.get('ghosts'), 'inactive');
    assert.equal(aliasesMap.get('remindme'), 'remind');

    const sent = [];
    const kickedTargets = [];
    const groupJid = '120363000000333333@g.us';
    const dmJid = '254755555555@s.whatsapp.net';

    const sock = {
      user: { id: '254700000001@s.whatsapp.net', name: 'Spider Man' },
      sendMessage: async (jid, payload) => {
        sent.push({ jid, payload });
        return { key: { id: `m-${sent.length}` } };
      },
      groupMetadata: async () => ({
        id: groupJid,
        subject: 'Alpha Squad',
        participants: [
          { id: '254700000001@s.whatsapp.net', admin: 'superadmin' }, // bot
          { id: '254755555555@s.whatsapp.net', admin: 'admin' },      // active admin
          { id: '254766666666@s.whatsapp.net', admin: null },         // active member
          { id: '254777777777@s.whatsapp.net', admin: null },         // 0-msg ghost
          { id: '254788888888@s.whatsapp.net', admin: 'admin' },      // 0-msg admin (must NOT be kicked)
        ],
      }),
      groupParticipantsUpdate: async (_gid, targets, action) => {
        kickedTargets.push(...targets);
        return targets.map((jid) => ({ jid, status: '200', action }));
      },
    };

    // Record sample activity
    defaultGroupActivityStore.recordMessage({ groupJid, senderJid: '254755555555@s.whatsapp.net' });
    defaultGroupActivityStore.recordMessage({ groupJid, senderJid: '254755555555@s.whatsapp.net' });
    defaultGroupActivityStore.recordMessage({ groupJid, senderJid: '254766666666@s.whatsapp.net' });

    const baseCtx = {
      sock,
      from: groupJid,
      sender: '254755555555@s.whatsapp.net',
      senderNumber: '254755555555',
      config: { BOT_NAME: 'Spider Man', ADMIN_PROTECTION: true },
      isOwner: false,
      isGroupAdmin: true,
      isBotGroupAdmin: true,
      msg: { key: { id: 'in-1', remoteJid: groupJid }, message: { conversation: 'test' } },
    };

    // 1. .active
    await commandsMap.get('active').execute({ ...baseCtx, text: '', args: [] });
    assert.match(sent.at(-1).payload.text, /ACTIVE MEMBERS/);
    assert.match(sent.at(-1).payload.text, /254755555555/);

    // 2. .leaderboard
    await commandsMap.get('leaderboard').execute({ ...baseCtx, text: '', args: [] });
    assert.match(sent.at(-1).payload.text, /GROUP LEADERBOARD/);
    assert.match(sent.at(-1).payload.text, /🥇/);

    // 3. .inactive list (shows ghosts 254777777777 and admin 254788888888)
    await commandsMap.get('inactive').execute({ ...baseCtx, text: '7d', args: ['7d'] });
    assert.match(sent.at(-1).payload.text, /INACTIVE MEMBERS/);
    assert.match(sent.at(-1).payload.text, /254777777777/);

    // 4. .inactive kick (only kicks non-admin ghost 254777777777, respects ADMIN_PROTECTION for 254788888888)
    await commandsMap.get('inactive').execute({ ...baseCtx, text: 'kick 7d', args: ['kick', '7d'] });
    assert.deepEqual(kickedTargets, ['254777777777@s.whatsapp.net']);
    assert.match(sent.at(-1).payload.text, /1\/1/);

    // 5. .remind, .reminders, .delremind in DM
    await commandsMap.get('remind').execute({
      ...baseCtx,
      from: dmJid,
      text: '2h Check deployment',
      args: ['2h', 'Check', 'deployment'],
    });
    assert.match(sent.at(-1).payload.text, /REMINDER SET/);
    assert.match(sent.at(-1).payload.text, /Check deployment/);

    // Quoted message .remind 30m
    await commandsMap.get('remind').execute({
      ...baseCtx,
      from: dmJid,
      text: '30m',
      args: ['30m'],
      msg: {
        key: { id: 'q-rem', remoteJid: dmJid },
        message: {
          extendedTextMessage: {
            text: '.remind 30m',
            contextInfo: { quotedMessage: { conversation: 'Restart worker dyno' } },
          },
        },
      },
    });
    assert.match(sent.at(-1).payload.text, /Restart worker dyno/);

    await commandsMap.get('reminders').execute({ ...baseCtx, from: dmJid, text: '', args: [] });
    const listText = sent.at(-1).payload.text;
    assert.match(listText, /ACTIVE REMINDERS/);
    assert.match(listText, /Check deployment/);
    assert.match(listText, /Restart worker dyno/);

    const idMatch = listText.match(/\*(R[A-F0-9]+)\*/);
    assert.ok(idMatch, 'Expected reminder ID in .reminders output');
    await commandsMap.get('delremind').execute({
      ...baseCtx,
      from: dmJid,
      text: idMatch[1],
      args: [idMatch[1]],
    });
    assert.match(sent.at(-1).payload.text, /REMINDER DELETED/);

    await commandsMap.get('delremind').execute({
      ...baseCtx,
      from: dmJid,
      text: 'all',
      args: ['all'],
    });
    assert.match(sent.at(-1).payload.text, /REMINDERS CLEARED/);
  } finally {
    console.warn = origWarn;
    defaultGroupActivityStore.clearCache();
    defaultReminderStore.clearCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
