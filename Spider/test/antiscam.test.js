import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let reloadCommandsFromDisk;
let loadLegacyCommands;
let config;
let antiscamUtils;

const commandsMap = new Map();
const aliasesMap = new Map();
const origFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => Buffer.from(''),
  });

  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const handle = origSetInterval(...args);
    handle?.unref?.();
    return handle;
  };

  try {
    ({ reloadCommandsFromDisk } = await import('../../spider/utils/runtimeControl.js'));
    ({ loadLegacyCommands } = await import('../utils/legacyPlugins.js'));
    config = (await import('../../spider/config.js')).default;
    antiscamUtils = await import('../../spider/utils/antiscam.js');

    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999101,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

after(() => {
  globalThis.fetch = origFetch;
});

function createGroupMockSock({ botId = '254700000099@s.whatsapp.net', botIsAdmin = true } = {}) {
  const sent = [];
  const kicked = [];
  const settingsUpdates = [];
  const metadata = {
    id: '120363000000009999@g.us',
    subject: 'Security Test Group',
    owner: '254700000001@s.whatsapp.net',
    participants: [
      { id: '254700000001@s.whatsapp.net', admin: 'superadmin' },
      { id: '254700000002@s.whatsapp.net', admin: 'admin' },
      { id: '254700000003@s.whatsapp.net', admin: null },
      { id: '254700000004@s.whatsapp.net', admin: null },
      { id: botId, admin: botIsAdmin ? 'admin' : null },
    ],
  };

  return {
    sent,
    kicked,
    settingsUpdates,
    metadata,
    sock: {
      user: { id: `${botId.split('@')[0]}:1@s.whatsapp.net` },
      sendMessage: async (jid, payload, options = {}) => {
        const record = { id: `msg-${sent.length + 1}`, jid, payload, options };
        sent.push(record);
        return { key: { id: record.id, remoteJid: jid, fromMe: true } };
      },
      groupParticipantsUpdate: async (jid, participants, action) => {
        kicked.push({ jid, participants, action });
        return participants.map((p) => ({ status: '200', jid: p }));
      },
      groupSettingUpdate: async (jid, setting) => {
        settingsUpdates.push({ jid, setting });
        return { status: '200' };
      },
      groupMetadata: async () => metadata,
    },
  };
}

test('antiscam command is registered with group/admin/botAdmin guards and appears in Group category', async () => {
  const cmd = commandsMap.get('antiscam');
  assert.ok(cmd, 'antiscam command must be registered');
  assert.equal(cmd.category, 'Group');
  assert.equal(cmd.groupOnly, true);
  assert.equal(cmd.adminOnly, true);
  assert.equal(cmd.botAdminOnly, true);
  assert.equal(aliasesMap.get('noscams'), 'antiscam');
  assert.equal(aliasesMap.get('scamguard'), 'antiscam');
  assert.equal(aliasesMap.get('antiphish'), 'antiscam');

  const { sock, sent } = createGroupMockSock();
  await commandsMap.get('category').execute({
    sock,
    from: '120363000000009999@g.us',
    text: 'group',
    args: ['group'],
    commands: commandsMap,
    commandAliases: aliasesMap,
    config,
    msg: { key: { id: 'cat-1' } },
  });
  assert.match(sent[0].payload.text, /ᴀɴᴛɪsᴄᴀᴍ|antiscam/i);
});

test('detectScamMessage catches real scam patterns and avoids false positives on normal chat', () => {
  const { detectScamMessage } = antiscamUtils;

  const scamSamples = [
    'Send me the 6-digit verification code WhatsApp sent you by mistake',
    'Connect your wallet to claim your free airdrop at https://claim-airdrop.xyz/mint',
    'Double your BTC today! Send 0.1 BTC to receive 0.2 BTC back immediately',
    'URGENT! Your WhatsApp account will be suspended. Verify at http://wa-verify.tk/login',
    'Congratulations you won $5000 cash prize! Pay registration fee to unlock now',
    'Cash flip guaranteed daily profit ROI 100%, DM me on Telegram t.me/scammer',
    'Earn $300 daily airdrop giveaway USDT! Limited time, click the link https://bit.ly/freeusdt',
    'Get bank logs and CVV dumps cheap right now',
    'S\u200be\u200bn\u200bd your 12-word recovery phrase to validate wallet',
    'Sell spendable flash USDT TRC20 cheap rate',
    'CashApp glitch method and PayPal logs available DM',
    'Mpesa reversal and Fuliza bypass tool working 100%',
    'Aviator predictor and fixed matches sure fixed odds today',
    'Complete prepaid task to withdraw $500 daily income',
    'Quick loan approval fee $20 no collateral instant loan',
    'Join Illuminati brotherhood for magic wallet money ritual',
    'Send money or I leak your nudes recorded your screen',
    'Hire a hacker to hack any WhatsApp or unban banned account',
    'Download keylogger apk and scampage phishing kit',
    'Send your s.e.e.d p.h.r.a.s.e or try this b1tc01n fl1p',
  ];

  for (const sample of scamSamples) {
    const res = detectScamMessage(sample);
    assert.equal(res.isScam, true, `Expected scam detection for: ${sample}`);
    assert.ok(res.score >= 4, `Expected score >= 4 for: ${sample}`);
  }

  // Strict mode (default) catches suspicious shortened/risky links immediately while standard mode allows single link
  const shortLinkMsg = 'Check this out https://bit.ly/check-promo-2026';
  const strictRes = detectScamMessage(shortLinkMsg, { strict: true });
  assert.equal(strictRes.isScam, true);
  assert.equal(strictRes.threshold, 3);
  const standardRes = detectScamMessage(shortLinkMsg, { strict: false });
  assert.equal(standardRes.isScam, false);
  assert.equal(standardRes.threshold, 4);

  const benignSamples = [
    'Good morning everyone, how is the project going?',
    'Check out the Node.js release notes: https://github.com/nodejs/node',
    'Urgent team meeting starts in 10 minutes on Zoom.',
    'Did anyone buy bitcoin or eth back in 2021?',
    'Please send the PDF link when you are ready.',
  ];

  for (const sample of benignSamples) {
    const res = detectScamMessage(sample);
    assert.equal(res.isScam, false, `False positive on benign message: ${sample}`);
  }
});

test('antiscam command manages on/off, delete/kick/warn/warnkick modes, custom rules, whitelist, and test scans', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antiscam-cmd-'));
  t.mock.method(process, 'cwd', () => tmpDir);
  antiscamUtils.defaultAntiscamStore.clearCache();

  try {
    const groupJid = '120363000000009999@g.us';
    const { sock, sent } = createGroupMockSock();
    const cmd = commandsMap.get('antiscam');
    const makeCmdCtx = (text, extra = {}) => ({
      sock,
      from: groupJid,
      text,
      args: text ? text.split(/\s+/) : [],
      config,
      isOwner: true,
      isGroupAdmin: true,
      isBotGroupAdmin: true,
      msg: {
        key: { id: `cmd-${sent.length + 1}`, remoteJid: groupJid, fromMe: false, participant: '254700000001@s.whatsapp.net' },
        message: { conversation: `.antiscam ${text}` },
      },
      ...extra,
    });

    // Guard checks when called directly
    await cmd.execute(makeCmdCtx('', { from: '254700000001@s.whatsapp.net' }));
    assert.match(sent.at(-1).payload.text, /only be used in a group/i);

    await cmd.execute(makeCmdCtx('on', { isGroupAdmin: false, isOwner: false }));
    assert.match(sent.at(-1).payload.text, /Only a group admin/i);

    await cmd.execute(makeCmdCtx('on', { isBotGroupAdmin: false }));
    assert.match(sent.at(-1).payload.text, /needs group admin/i);

    // Status card
    await cmd.execute(makeCmdCtx(''));
    assert.match(sent.at(-1).payload.text, /ANTISCAM SHIELD/);
    assert.match(sent.at(-1).payload.text, /OFF ❌/);

    // Enable with kick in one shot
    await cmd.execute(makeCmdCtx('on kick'));
    assert.match(sent.at(-1).payload.text, /ANTISCAM ENABLED/);
    assert.match(sent.at(-1).payload.text, /DELETE & KICK/);
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).enabled, true);
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).action, 'kick');

    // Switch action to warnkick, warnlimit 2, strict toggle, and mute mode
    await cmd.execute(makeCmdCtx('warnkick'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).action, 'warnkick');
    await cmd.execute(makeCmdCtx('warnlimit 2'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).maxWarns, 2);
    await cmd.execute(makeCmdCtx('strict off'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).strict, false);
    await cmd.execute(makeCmdCtx('strict on'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).strict, true);
    await cmd.execute(makeCmdCtx('mute'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).action, 'mute');
    assert.match(sent.at(-1).payload.text, /DELETE & MUTE GROUP/);

    // Custom phrase rules
    await cmd.execute(makeCmdCtx('addword scamcoin-presale'));
    assert.match(sent.at(-1).payload.text, /Added custom Anti-Scam rule/);
    await cmd.execute(makeCmdCtx('words'));
    assert.match(sent.at(-1).payload.text, /scamcoin-presale/);
    await cmd.execute(makeCmdCtx('test Join our scamcoin-presale right now'));
    assert.match(sent.at(-1).payload.text, /SCAM DETECTED/);
    assert.match(sent.at(-1).payload.text, /3\+ threshold/);
    await cmd.execute(makeCmdCtx('delword scamcoin-presale'));
    assert.match(sent.at(-1).payload.text, /Removed custom Anti-Scam rule/);

    // Whitelist domain & test exemption
    await cmd.execute(makeCmdCtx('whitelist add trusted-promo.com'));
    assert.match(sent.at(-1).payload.text, /Added \*trusted-promo\.com\*/);
    await cmd.execute(makeCmdCtx('whitelist list'));
    assert.match(sent.at(-1).payload.text, /trusted-promo\.com/);
    await cmd.execute(makeCmdCtx('whitelist remove trusted-promo.com'));
    assert.match(sent.at(-1).payload.text, /Removed \*trusted-promo\.com\*/);

    // Notify toggle & resetwarns
    await cmd.execute(makeCmdCtx('notify off'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).notify, false);
    await cmd.execute(makeCmdCtx('notify on'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).notify, true);

    // Disable
    await cmd.execute(makeCmdCtx('off'));
    assert.equal(antiscamUtils.defaultAntiscamStore.getGroupConfig(groupJid).enabled, false);
    assert.ok(fs.existsSync(path.join(tmpDir, 'data', 'antiscam.json')));
  } finally {
    antiscamUtils.defaultAntiscamStore.clearCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleAntiScamMessage enforces delete, kick, warn, warnkick, and respects admin/owner/botAdmin guards', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antiscam-enforce-'));
  const store = antiscamUtils.createAntiscamStore(path.join(tmpDir, 'antiscam.json'));

  try {
    const groupJid = '120363000000009999@g.us';
    const scammer = '254700000003@s.whatsapp.net';
    const adminUser = '254700000002@s.whatsapp.net';

    const buildMsg = (id, sender, text, wrapped = false) => ({
      key: { id, remoteJid: groupJid, fromMe: false, participant: sender },
      message: wrapped
        ? { viewOnceMessageV2: { message: { imageMessage: { caption: text } } } }
        : { conversation: text },
    });

    // 1. Delete mode (also tests viewOnce wrapped caption extraction)
    store.setGroupConfig(groupJid, { enabled: true, action: 'delete', notify: true });
    let env = createGroupMockSock();
    let res = await antiscamUtils.handleAntiScamMessage({
      sock: env.sock,
      from: groupJid,
      sender: scammer,
      msg: buildMsg('scam-1', scammer, 'Send your 12-word seed phrase to claim airdrop', true),
      store,
    });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.kicked, false);
    assert.equal(env.kicked.length, 0);
    assert.deepEqual(env.sent[0].payload.delete, {
      remoteJid: groupJid,
      fromMe: false,
      id: 'scam-1',
      participant: scammer,
    });
    assert.equal(res.warningMessage, 'No scam or phishing messages allowed in this group!');
    assert.match(env.sent[1].payload.text, /MESSAGE DELETED/);
    assert.match(env.sent[1].payload.text, /\*WARNING\*\s*›\s*No scam or phishing messages allowed in this group!/);

    // 2. Kick mode: deletes message AND kicks user
    store.setGroupConfig(groupJid, { enabled: true, action: 'kick', notify: true });
    env = createGroupMockSock();
    res = await antiscamUtils.handleAntiScamMessage({
      sock: env.sock,
      from: groupJid,
      sender: scammer,
      msg: buildMsg('scam-2', scammer, 'Forward your 6-digit verification code WhatsApp sent you by mistake'),
      store,
    });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.kicked, true);
    assert.equal(env.kicked.length, 1);
    assert.deepEqual(env.kicked[0], {
      jid: groupJid,
      participants: [scammer],
      action: 'remove',
    });
    assert.match(env.sent[1].payload.text, /DELETED & KICKED/);

    // 3. Warnkick mode: warns up to maxWarns (2), then kicks and resets
    store.setGroupConfig(groupJid, { enabled: true, action: 'warnkick', maxWarns: 2, notify: true });
    env = createGroupMockSock();
    const warn1 = await antiscamUtils.handleAntiScamMessage({
      sock: env.sock,
      from: groupJid,
      sender: scammer,
      msg: buildMsg('scam-3', scammer, 'Double your BTC! Send 0.1 BTC to get 0.2 BTC'),
      store,
    });
    assert.equal(warn1.handled, true);
    assert.equal(warn1.deleted, true);
    assert.equal(warn1.warnCount, 1);
    assert.equal(warn1.kicked, false);
    assert.equal(env.kicked.length, 0);
    assert.match(env.sent[1].payload.text, /1\/2/);

    const warn2 = await antiscamUtils.handleAntiScamMessage({
      sock: env.sock,
      from: groupJid,
      sender: scammer,
      msg: buildMsg('scam-4', scammer, 'Double your BTC! Send 0.1 BTC to get 0.2 BTC'),
      store,
    });
    assert.equal(warn2.handled, true);
    assert.equal(warn2.deleted, true);
    assert.equal(warn2.warnCount, 2);
    assert.equal(warn2.kicked, true);
    assert.equal(env.kicked.length, 1);
    assert.equal(Object.keys(store.getGroupConfig(groupJid).warns).length, 0);

    // 4. Admins, owners, and non-admin-bot groups are safely skipped
    env = createGroupMockSock();
    const adminRes = await antiscamUtils.handleAntiScamMessage({
      sock: env.sock,
      from: groupJid,
      sender: adminUser,
      msg: buildMsg('scam-admin', adminUser, 'Send your 12-word seed phrase'),
      store,
    });
    assert.equal(adminRes.handled, false);
    assert.equal(adminRes.reason, 'sender-is-admin');
    assert.equal(env.sent.length, 0);

    const nonBotAdminEnv = createGroupMockSock({ botIsAdmin: false });
    const botRes = await antiscamUtils.handleAntiScamMessage({
      sock: nonBotAdminEnv.sock,
      from: groupJid,
      sender: scammer,
      msg: buildMsg('scam-no-admin', scammer, 'Send your 12-word seed phrase'),
      store,
    });
    assert.equal(botRes.handled, false);
    assert.equal(botRes.reason, 'bot-not-admin');
    assert.equal(nonBotAdminEnv.sent.length, 0);

    // 5. Mute mode: deletes scam message AND locks group immediately
    store.setGroupConfig(groupJid, { enabled: true, action: 'mute', notify: true });
    env = createGroupMockSock();
    const muteRes = await antiscamUtils.handleAntiScamMessage({
      sock: env.sock,
      from: groupJid,
      sender: scammer,
      msg: buildMsg('scam-mute', scammer, 'Flash USDT TRC20 available DM me now'),
      store,
    });
    assert.equal(muteRes.handled, true);
    assert.equal(muteRes.deleted, true);
    assert.equal(muteRes.muted, true);
    assert.deepEqual(env.settingsUpdates, [{ jid: groupJid, setting: 'announcement' }]);
    assert.match(env.sent[1].payload.text, /DELETED & GROUP MUTED/);

    // 6. Whitelisted sender via @lid / participantAlt identity is exempted
    store.addWhitelist(groupJid, '254700000004');
    env = createGroupMockSock();
    const lidMsg = {
      key: {
        id: 'scam-wl-lid',
        remoteJid: groupJid,
        fromMe: false,
        participant: '1234567890123@lid',
        participantAlt: '254700000004@s.whatsapp.net',
      },
      message: { conversation: 'Double your BTC today! Send 0.1 BTC' },
    };
    const wlRes = await antiscamUtils.handleAntiScamMessage({
      sock: env.sock,
      from: groupJid,
      sender: '1234567890123@lid',
      msg: lidMsg,
      store,
    });
    assert.equal(wlRes.handled, false);
    assert.equal(wlRes.reason, 'whitelisted');
    assert.equal(env.sent.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('spider/index.js hooks handleAntiScamMessage into live group message handling', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'spider', 'index.js'), 'utf8');
  assert.ok(indexSource.includes('./utils/antiscam.js'), 'spider/index.js must import utils/antiscam.js');
  assert.ok(indexSource.includes('handleAntiScamMessage('), 'spider/index.js must call handleAntiScamMessage');
});
