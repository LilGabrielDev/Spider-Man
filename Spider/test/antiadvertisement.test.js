import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let reloadCommandsFromDisk;
let loadLegacyCommands;
let config;
let antiAdUtils;

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
    antiAdUtils = await import('../../spider/utils/antiadvertisement.js');

    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999303,
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
    id: '120363000000007777@g.us',
    subject: 'AntiAd Test Group',
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
        return {};
      },
      groupMetadata: async () => metadata,
    },
  };
}

test('antiadvertisement command is registered with group/admin/botAdmin guards and appears in Group category', async () => {
  const cmd = commandsMap.get('antiadvertisement');
  assert.ok(cmd, 'antiadvertisement command must be registered');
  assert.equal(cmd.category, 'Group');
  assert.equal(cmd.groupOnly, true);
  assert.equal(cmd.adminOnly, true);
  assert.equal(cmd.botAdminOnly, true);
  assert.equal(aliasesMap.get('antiad'), 'antiadvertisement');
  assert.equal(aliasesMap.get('antiads'), 'antiadvertisement');
  assert.equal(aliasesMap.get('noads'), 'antiadvertisement');
  assert.equal(aliasesMap.get('antiadvert'), 'antiadvertisement');
  assert.equal(aliasesMap.get('adguard'), 'antiadvertisement');
  assert.equal(aliasesMap.get('antipromo'), 'antiadvertisement');

  const { sock, sent } = createGroupMockSock();
  await commandsMap.get('category').execute({
    sock,
    from: '120363000000007777@g.us',
    text: 'group',
    args: ['group'],
    commands: commandsMap,
    commandAliases: aliasesMap,
    config,
    msg: { key: { id: 'cat-aa-1' } },
  });
  assert.match(sent[0].payload.text, /ᴀɴᴛɪᴀᴅ[vᴠ]ᴇʀᴛɪsᴇᴍᴇɴᴛ|antiadvertisement/i);
});

test('detectAdvertisementMessage catches data bundles, till promos, Fuliza, KPLC tokens, pharma ads, group links, and avoids benign chat false positives', () => {
  const { detectAdvertisementMessage } = antiAdUtils;

  const fullUserSample = `*GET 1GB VALID TILL MIDNIGHT @KSH 55   PATA MINUTES, DATA BUNDLES NA SMS* 
Hata ukiwa na Okoa Jahazi ✅

 *TILL NUMBER 4382247* *(JAMLIC)* 

DATA DEALS *( buy once)*
♦️ *Ksh55=1Gb till midnight* 🔥🔥
♦️Ksh19=1Gb(1hr)11pm to 7pm* 
♦️ *Ksh20=250Mbs (24hrs)🔥*
♦️ *Ksh53=750mbs +50sms (24hrs) 🔥🔥
 ♦️*Ksh99=1.5Gb( 24hr)* 
♦️Ksh50=400Mbs( 7days)* 

BUY MANY TIMES(TILL =4382247)*  
💚Ksh 56=750mbs+50sms+free WhatsApp (24hrs)
💚*Ksh15=60mbs + 50sms (24hrs)*
💚*Ksh103=1.5GB +50sms (24hrs)*

*MINUTES* ( *buy many times)* 
TILL NUMBER 4382247
🔶️Ksh22=45 mins(3hr)🔥
🔶️Ksh500=300 mins( 30 days)

SMS DEALS (buy many times)*
TILL NUMBER 4382247
🔵Ksh5=20 sms (24hrs)
🔵Ksh30=1000 sms (7 days)

USE 
▪️TILL NUMBER *4382247*
https://chat.whatsapp.com/If4pqGG08uwCybHQvIiYwY?s=cl&p=a&iam=2`;

  const heistSample = `HEIST HEIST HEIST

10GB +500mins @70

NO EXPIRY
20GB +1000mins @100
35GB +1500mins @150
50GB +2500mins  @250
100GB +4500mins @500

UNLIMITED DATA @1250`;

  const fulizaSample = `FULIZA
5K @350
10K@550
20K@1050
50K@1800
100K@3500`;

  const kplcSample = `KPLC Tokens 
100units @300
150units@450`;

  const healthSample = `⭕ *_TO WHOM IT MAY CONCERN_* ⭕

💊REPRODUCTIVE HEALTH MEDICATION 💊

 *ABORTION PILLS* 

⭕⭕⭕⭕⭕⭕⭕

STI and STD Treatment 

Titan gel
Butt booster

Weight gain 
Weight loss 

Flat tummy 
Skin Whitening 
Acne treatment

⭕ Payment can be done after delivery depending on our clients location. DM or Call for inquiries ⭕`;

  const adSamples = [
    fullUserSample,
    heistSample,
    fulizaSample,
    kplcSample,
    healthSample,
    '*GET 1GB VALID TILL MIDNIGHT @KSH 55 PATA MINUTES, DATA BUNDLES NA SMS*',
    'Join our promo group now: https://chat.whatsapp.com/If4pqGG08uwCybHQvIiYwY',
    'Abortion pills and Titan gel available, DM or call for inquiries, countrywide delivery',
    'VIP forex signals & sure odds fixed matches! DM to order, payment after delivery wa.me/254712345678',
    'Buy real Instagram followers and cheap Netflix accounts today',
    'Order now, countrywide delivery available in stock!',
    '1GB @Ksh50',
    'DM me on https://tiktok.com/@promo_vendor_ke',
    'Cheap d4t4 d34ls with t.i.l.l n.u.m.b.e.r 4382247',
  ];

  for (const sample of adSamples) {
    const res = detectAdvertisementMessage(sample);
    assert.equal(res.isAd, true, `Expected ad detection for:\n${sample.slice(0, 120)}`);
    assert.ok(res.score >= 3, `Expected score >= 3, got ${res.score}`);
  }

  // Strict mode (default) blocks single promo CTA/price/social link immediately while standard mode uses 4+ threshold
  const singlePromoCta = 'Order now! Countrywide delivery available';
  const strictCta = detectAdvertisementMessage(singlePromoCta, { strict: true });
  assert.equal(strictCta.isAd, true);
  assert.equal(strictCta.threshold, 3);
  const standardCta = detectAdvertisementMessage(singlePromoCta, { strict: false });
  assert.equal(standardCta.isAd, false);
  assert.equal(standardCta.threshold, 4);

  const benignSamples = [
    'Good morning team, let us meet at 3pm to review the codebase.',
    'Has anyone checked how much 1GB Safaricom bundle costs today?',
    'Did you already buy KPLC tokens for the office meter?',
    'Check out the Node.js docs at https://nodejs.org/en/docs',
    'I am starting a new weight loss workout plan at the gym this week.',
    'Please share the till number for our group dinner contribution.',
  ];

  for (const sample of benignSamples) {
    const res = detectAdvertisementMessage(sample);
    assert.equal(res.isAd, false, `False positive on benign message: ${sample} (score=${res.score}, cats=${res.categories})`);
  }
});

test('antiadvertisement command manages on/off, actions, warnlimit, notify, custom words, whitelist, and test scans', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antiad-cmd-'));
  t.mock.method(process, 'cwd', () => tmpDir);
  antiAdUtils.defaultAntiadvertisementStore.clearCache();

  try {
    const groupJid = '120363000000007777@g.us';
    const { sock, sent } = createGroupMockSock();
    const cmd = commandsMap.get('antiadvertisement');
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
        message: { conversation: `.antiadvertisement ${text}` },
      },
      ...extra,
    });

    // Guard checks
    await cmd.execute(makeCmdCtx('', { from: '254700000001@s.whatsapp.net' }));
    assert.match(sent.at(-1).payload.text, /only be used in a group/i);

    await cmd.execute(makeCmdCtx('on', { isGroupAdmin: false, isOwner: false }));
    assert.match(sent.at(-1).payload.text, /Only a group admin/i);

    await cmd.execute(makeCmdCtx('on', { isBotGroupAdmin: false }));
    assert.match(sent.at(-1).payload.text, /needs group admin/i);

    // Status card
    await cmd.execute(makeCmdCtx(''));
    assert.match(sent.at(-1).payload.text, /ANTI-ADVERTISEMENT SHIELD/);
    assert.match(sent.at(-1).payload.text, /OFF ❌/);

    // Enable with kick
    await cmd.execute(makeCmdCtx('on kick'));
    assert.match(sent.at(-1).payload.text, /ANTI-AD ENABLED/);
    assert.match(sent.at(-1).payload.text, /DELETE & KICK/);
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).enabled, true);
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).action, 'kick');

    // Warnkick + warnlimit + strict toggle
    await cmd.execute(makeCmdCtx('warnkick'));
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).action, 'warnkick');
    await cmd.execute(makeCmdCtx('warnlimit 2'));
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).maxWarns, 2);
    await cmd.execute(makeCmdCtx('strict off'));
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).strict, false);
    await cmd.execute(makeCmdCtx('strict on'));
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).strict, true);

    // Custom rule + test scan + remove rule
    await cmd.execute(makeCmdCtx('addword jamlic'));
    assert.match(sent.at(-1).payload.text, /Added custom Anti-Advertisement rule/);
    await cmd.execute(makeCmdCtx('words'));
    assert.match(sent.at(-1).payload.text, /jamlic/);
    await cmd.execute(makeCmdCtx('test Buy bundles via Jamlic now'));
    assert.match(sent.at(-1).payload.text, /AD DETECTED/);
    assert.match(sent.at(-1).payload.text, /3\+ threshold/);
    await cmd.execute(makeCmdCtx('delword jamlic'));
    assert.match(sent.at(-1).payload.text, /Removed custom Anti-Advertisement rule/);

    // Whitelist
    await cmd.execute(makeCmdCtx('whitelist add 254700000004'));
    assert.match(sent.at(-1).payload.text, /Added \*254700000004\*/);
    await cmd.execute(makeCmdCtx('whitelist list'));
    assert.match(sent.at(-1).payload.text, /254700000004/);
    await cmd.execute(makeCmdCtx('whitelist remove 254700000004'));
    assert.match(sent.at(-1).payload.text, /Removed \*254700000004\*/);

    // Notify toggle & resetwarns
    await cmd.execute(makeCmdCtx('notify off'));
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).notify, false);
    await cmd.execute(makeCmdCtx('notify on'));
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).notify, true);

    // Disable & check persistence
    await cmd.execute(makeCmdCtx('off'));
    assert.equal(antiAdUtils.defaultAntiadvertisementStore.getGroupConfig(groupJid).enabled, false);
    assert.ok(fs.existsSync(path.join(tmpDir, 'data', 'antiadvertisement.json')));
  } finally {
    antiAdUtils.defaultAntiadvertisementStore.clearCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleAntiAdvertisementMessage enforces delete, kick, warnkick, mute, and respects admin/whitelist/botAdmin guards', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antiad-enforce-'));
  const store = antiAdUtils.createAntiadvertisementStore(path.join(tmpDir, 'antiadvertisement.json'));

  try {
    const groupJid = '120363000000007777@g.us';
    const advertiser = '254700000003@s.whatsapp.net';
    const whitelistedUser = '254700000004@s.whatsapp.net';
    const adminUser = '254700000002@s.whatsapp.net';

    const buildMsg = (id, sender, text, wrapped = false) => ({
      key: { id, remoteJid: groupJid, fromMe: false, participant: sender },
      message: wrapped
        ? { viewOnceMessageV2: { message: { imageMessage: { caption: text } } } }
        : { conversation: text },
    });

    // 1. Delete mode (including viewOnce caption)
    store.setGroupConfig(groupJid, { enabled: true, action: 'delete', notify: true });
    let env = createGroupMockSock();
    let res = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: env.sock,
      from: groupJid,
      sender: advertiser,
      msg: buildMsg('ad-1', advertiser, 'FULIZA\n5K @350\n10K@550\n20K@1050', true),
      store,
    });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.kicked, false);
    assert.equal(env.kicked.length, 0);
    assert.deepEqual(env.sent[0].payload.delete, {
      remoteJid: groupJid,
      fromMe: false,
      id: 'ad-1',
      participant: advertiser,
    });
    assert.equal(res.warningMessage, 'No advertisements or promotions allowed in this group!');
    assert.match(env.sent[1].payload.text, /ANTI-ADVERTISEMENT SHIELD/);
    assert.match(env.sent[1].payload.text, /MESSAGE DELETED/);
    assert.match(env.sent[1].payload.text, /\*WARNING\*\s*›\s*No advertisements or promotions allowed in this group!/);

    // 2. Kick mode: deletes and removes advertiser
    store.setGroupConfig(groupJid, { enabled: true, action: 'kick', notify: true });
    env = createGroupMockSock();
    res = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: env.sock,
      from: groupJid,
      sender: advertiser,
      msg: buildMsg('ad-2', advertiser, 'KPLC Tokens\n100units @300\n150units@450'),
      store,
    });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.kicked, true);
    assert.deepEqual(env.kicked[0], {
      jid: groupJid,
      participants: [advertiser],
      action: 'remove',
    });
    assert.match(env.sent[1].payload.text, /DELETED & KICKED/);

    // 3. Warnkick mode: warns up to maxWarns (2), then kicks and resets
    store.setGroupConfig(groupJid, { enabled: true, action: 'warnkick', maxWarns: 2, notify: true });
    env = createGroupMockSock();
    const warn1 = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: env.sock,
      from: groupJid,
      sender: advertiser,
      msg: buildMsg('ad-3', advertiser, 'ABORTION PILLS · STI and STD Treatment · DM or Call for inquiries'),
      store,
    });
    assert.equal(warn1.handled, true);
    assert.equal(warn1.warnCount, 1);
    assert.equal(warn1.kicked, false);
    assert.match(env.sent[1].payload.text, /1\/2/);

    const warn2 = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: env.sock,
      from: groupJid,
      sender: advertiser,
      msg: buildMsg('ad-4', advertiser, 'HEIST HEIST HEIST 10GB +500mins @70 20GB +1000mins @100 35GB @150'),
      store,
    });
    assert.equal(warn2.handled, true);
    assert.equal(warn2.warnCount, 2);
    assert.equal(warn2.kicked, true);
    assert.equal(env.kicked.length, 1);
    assert.equal(Object.keys(store.getGroupConfig(groupJid).warns).length, 0);

    // 4. Mute mode
    store.setGroupConfig(groupJid, { enabled: true, action: 'mute', notify: true });
    env = createGroupMockSock();
    const muteRes = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: env.sock,
      from: groupJid,
      sender: advertiser,
      msg: buildMsg('ad-5', advertiser, 'https://chat.whatsapp.com/If4pqGG08uwCybHQvIiYwY'),
      store,
    });
    assert.equal(muteRes.handled, true);
    assert.equal(muteRes.muted, true);
    assert.deepEqual(env.settingsUpdates, [{ jid: groupJid, setting: 'announcement' }]);
    assert.match(env.sent[1].payload.text, /GROUP MUTED/);

    // 5. Whitelist, admin, and non-admin bot guards
    store.addWhitelist(groupJid, '254700000004');
    env = createGroupMockSock();
    const wlRes = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: env.sock,
      from: groupJid,
      sender: whitelistedUser,
      msg: buildMsg('ad-wl', whitelistedUser, 'https://chat.whatsapp.com/If4pqGG08uwCybHQvIiYwY'),
      store,
    });
    assert.equal(wlRes.handled, false);
    assert.equal(wlRes.reason, 'whitelisted');
    assert.equal(env.sent.length, 0);

    const adminRes = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: env.sock,
      from: groupJid,
      sender: adminUser,
      msg: buildMsg('ad-adm', adminUser, 'https://chat.whatsapp.com/If4pqGG08uwCybHQvIiYwY'),
      store,
    });
    assert.equal(adminRes.handled, false);
    assert.equal(adminRes.reason, 'sender-is-admin');
    assert.equal(env.sent.length, 0);

    const nonBotAdminEnv = createGroupMockSock({ botIsAdmin: false });
    const botRes = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: nonBotAdminEnv.sock,
      from: groupJid,
      sender: advertiser,
      msg: buildMsg('ad-nba', advertiser, 'https://chat.whatsapp.com/If4pqGG08uwCybHQvIiYwY'),
      store,
    });
    assert.equal(botRes.handled, false);
    assert.equal(botRes.reason, 'bot-not-admin');
    assert.equal(nonBotAdminEnv.sent.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('spider/index.js hooks handleAntiAdvertisementMessage into live group message handling', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'spider', 'index.js'), 'utf8');
  assert.ok(
    indexSource.includes('./utils/antiadvertisement.js'),
    'spider/index.js must import utils/antiadvertisement.js',
  );
  assert.ok(
    indexSource.includes('handleAntiAdvertisementMessage('),
    'spider/index.js must call handleAntiAdvertisementMessage',
  );
});
