import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SILENT_LOGGER,
    createBaileysSignalLogger,
    isLibsignalConsoleNoise,
    installConsoleSignalSanitizer,
    redactPhoneOrJid,
    sanitizeConsoleText,
    logIncomingMessage,
    logCommandExecution,
    logStatusUpdate
} from '../../spider/utils/privacyLogger.js';
import { logStatus, processStatusMessage } from '../../spider/bc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

function withCapturedConsole(fn) {
    const captured = [];
    const orig = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug
    };
    for (const method of Object.keys(orig)) {
        console[method] = (...args) => {
            captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        };
    }
    const restore = () => {
        for (const method of Object.keys(orig)) {
            console[method] = orig[method];
        }
    };
    return Promise.resolve()
        .then(() => fn(captured))
        .finally(restore);
}

test('redactPhoneOrJid masks WhatsApp JIDs, LIDs, and phone numbers', () => {
    assert.equal(redactPhoneOrJid('254712345678@s.whatsapp.net'), '••••78@s.whatsapp.net');
    assert.equal(redactPhoneOrJid('254712345678:12@s.whatsapp.net'), '••••78@s.whatsapp.net');
    assert.equal(redactPhoneOrJid('120363399604046397@g.us'), '••••97@g.us');
    assert.equal(redactPhoneOrJid('99887766554433@lid'), '••••33@lid');
    assert.equal(redactPhoneOrJid('+254712345678'), '••••78');
    assert.equal(redactPhoneOrJid(''), '');
    assert.equal(redactPhoneOrJid(null), '');
});

test('sanitizeConsoleText removes tokens, JIDs, and phone numbers from strings and errors', () => {
    const raw = 'Failed for 254712345678@s.whatsapp.net with LIL~secretSessionToken123 and Bearer abcDEF123 in +254 712 345 678';
    const sanitized = sanitizeConsoleText(raw);
    assert.ok(!sanitized.includes('254712345678'));
    assert.ok(!sanitized.includes('secretSessionToken123'));
    assert.ok(!sanitized.includes('abcDEF123'));
    assert.ok(sanitized.includes('[redacted-token]'));
    assert.ok(sanitized.includes('Bearer [redacted]'));

    const errSanitized = sanitizeConsoleText(new Error('Timeout talking to 123456789012@lid'));
    assert.ok(!errSanitized.includes('123456789012'));
    assert.ok(errSanitized.includes('••••12@lid'));
});

test('SILENT_LOGGER and no-op loggers emit nothing to console', async () => {
    await withCapturedConsole((captured) => {
        assert.equal(SILENT_LOGGER.level, 'silent');
        SILENT_LOGGER.trace('secret trace');
        SILENT_LOGGER.debug('secret debug');
        SILENT_LOGGER.info('secret info');
        SILENT_LOGGER.warn('secret warn');
        SILENT_LOGGER.error('secret error');
        SILENT_LOGGER.fatal('secret fatal');
        SILENT_LOGGER.child({ module: 'baileys' }).info('child secret');

        logIncomingMessage('Private', '254712345678@s.whatsapp.net', 'secret message body');
        logCommandExecution('Alice', '254712345678', 'ping', 'Private Chat');
        logStatusUpdate('254712345678@s.whatsapp.net', 'MSG123', 'Alice', 'text', 'secret status');

        assert.equal(captured.length, 0);
    });
});

test('status processing and logStatus never print status content, sender, phone, JID, or message ID to console', async () => {
    const secretCaption = 'TOP_SECRET_STATUS_MESSAGE_CONTENT_987';
    const secretSenderName = 'Alice SecretContact';
    const secretJid = '254712345678@s.whatsapp.net';
    const secretStatusId = 'STATUS_ID_CONFIDENTIAL_42';

    await withCapturedConsole(async (captured) => {
        logStatus(secretJid, secretStatusId, secretSenderName, 'image', secretCaption);

        const mockSock = {
            readMessages: async () => {},
            onWhatsApp: async () => [{ notify: secretSenderName }],
            sendMessage: async () => {}
        };
        const statusMsg = {
            key: {
                remoteJid: 'status@broadcast',
                participant: secretJid,
                id: secretStatusId,
                fromMe: false
            },
            pushName: secretSenderName,
            message: {
                imageMessage: {
                    caption: secretCaption
                }
            }
        };

        await processStatusMessage(statusMsg, mockSock);

        const joined = captured.join('\n');
        assert.ok(!joined.includes(secretCaption), 'Status message content leaked to console');
        assert.ok(!joined.includes(secretSenderName), 'Status sender name leaked to console');
        assert.ok(!joined.includes('254712345678'), 'Status phone/JID leaked to console');
        assert.ok(!joined.includes(secretStatusId), 'Status message ID leaked to console');
    });
});

test('spider modules do not expose raw message loggers or pass console to downloadMediaMessage', () => {
    const indexSrc = fs.readFileSync(path.join(ROOT_DIR, 'spider/index.js'), 'utf8');
    assert.ok(indexSrc.includes("./utils/privacyLogger.js"));
    assert.ok(indexSrc.includes('return logIncomingMessage();'));
    assert.ok(indexSrc.includes('return logCommandExecution();'));
    assert.ok(!indexSrc.includes('0x186)+_0x261776'), 'Raw message text print should not exist');

    const bcSrc = fs.readFileSync(path.join(ROOT_DIR, 'spider/bc.js'), 'utf8');
    assert.ok(bcSrc.includes("./utils/privacyLogger.js"));
    assert.ok(bcSrc.includes('return logStatusUpdate();'));

    for (const relPath of [
        'spider/bc.js',
        'Spider/commands/Convertor.js',
        'Spider/commands/Save.js',
        'Spider/commands/Vision.js',
        'Spider/france/utils.js'
    ]) {
        const src = fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
        assert.ok(!/['"]?logger['"]?\s*:\s*console\b/.test(src), `${relPath} still passes raw console to downloadMediaMessage`);
    }
});

test('createBaileysSignalLogger stays silent for info/debug, redacts JIDs/phones, throttles duplicates, and tracks Signal diagnostics', async () => {
    await withCapturedConsole((captured) => {
        const logger = createBaileysSignalLogger({ throttleMs: 60_000 });
        logger.trace('trace secret 254712345678@s.whatsapp.net');
        logger.debug('debug secret 254712345678');
        logger.info({ jid: '254712345678@s.whatsapp.net' }, 'info secret');
        assert.equal(captured.length, 0);

        logger.warn({ jid: '254712345678@s.whatsapp.net', err: new Error('Bad MAC during decrypt') }, 'failed decrypt from 998877665544@lid');
        logger.warn({ jid: '254712345678@s.whatsapp.net', err: new Error('Bad MAC during decrypt') }, 'failed decrypt from 998877665544@lid');
        logger.error({ from: '120363399604046397@g.us', retryCount: 2 }, 'sending message again missing sender key session');

        const joined = captured.join('\n');
        assert.ok(!joined.includes('254712345678'), 'Phone/JID should be redacted');
        assert.ok(!joined.includes('998877665544'), 'LID should be redacted');
        assert.ok(!joined.includes('120363399604046397'), 'Group JID should be redacted');
        assert.equal(captured.length, 2, 'Duplicate warn within throttleMs must be throttled');

        const diag = logger.getDiagnostics();
        assert.equal(diag.warnings, 2);
        assert.equal(diag.errors, 1);
        assert.equal(diag.decryptFailures, 2);
        assert.equal(diag.retryFailures, 1);
        assert.equal(diag.sessionErrors, 1);
    });
});

test('redactPhoneOrJid and sanitizeConsoleText preserve status@broadcast, keyId numbers, and already-redacted JIDs across repeated passes', () => {
    assert.equal(redactPhoneOrJid('status@broadcast'), 'status@broadcast');
    assert.equal(redactPhoneOrJid('••••78@s.whatsapp.net'), '••••78@s.whatsapp.net');

    const msg = 'No session found for keyId=123499, group=status@broadcast::254712345605_1::0 from 254712345678@s.whatsapp.net';
    const once = sanitizeConsoleText(msg);
    const twice = sanitizeConsoleText(once);
    assert.equal(once, twice, 'Repeated sanitization must be idempotent');
    assert.ok(once.includes('keyId=123499'));
    assert.ok(once.includes('group=status@broadcast::••••05_1::0'));
    assert.ok(once.includes('••••78@s.whatsapp.net'));
    assert.ok(!once.includes('[redacted]@broadcast'));
});

test('createBaileysSignalLogger filters redundant rollback/newsletter/parking/status noise, strips stacks, normalizes keyId dedupe, and notifies missing app-state keys', async () => {
    await withCapturedConsole((captured) => {
        const missingKeys = [];
        const logger = createBaileysSignalLogger({
            throttleMs: 60_000,
            onMissingAppStateKey: (kid) => missingKeys.push(kid)
        });

        // Redundant rollback, benign newsletter, Invalid PreKey ID, ack error, and transient status@broadcast decrypt stay silent while tracked
        logger.error({ err: new Error('No session found to decrypt message') }, 'transaction failed, rolling back');
        logger.warn('Invalid mex newsletter notification content');
        logger.error(
            { err: new Error('No session found to decrypt message for keyId=123499, group=status@broadcast::254712345605_1::0') },
            'failed to decrypt message'
        );
        logger.error(
            { key: { remoteJid: 'status@broadcast', participant: '556677889925@lid' }, err: new Error('No session record') },
            'failed to decrypt message'
        );
        logger.warn({ trace: 'Error: Cannot find package link-preview-js' }, 'url generation failed');
        logger.error(
            { key: { remoteJid: '123456789012@lid' }, err: new Error('Invalid PreKey ID') },
            'failed to decrypt message'
        );
        logger.error(
            { key: { remoteJid: '445566778838@lid' }, err: new Error('Bad MAC: No session record') },
            'failed to decrypt message'
        );
        logger.error(
            { key: { remoteJid: '445566778838@lid' }, err: new Error('Bad MAC: No matching sessions found for message') },
            'failed to decrypt message'
        );
        logger.error(
            { key: { remoteJid: 'status@broadcast', participant: '445566778838@lid' }, err: new Error('Received message with old counter: 7, 0') },
            'failed to decrypt message'
        );
        logger.error(
            { key: { remoteJid: 'status@broadcast', participant: '445566778895@lid' }, err: Object.assign(new Error('MessageCounterError: stale chain'), { name: 'MessageCounterError' }) },
            'failed to decrypt message'
        );
        logger.error('failed to decrypt message | No session found to decrypt message for keyId=1296392376, group=120363399604046395@g.us::1122334414_1::0 jid=120363399604046395@g.us participant=1122334414@lid');
        logger.warn({ msgId: 'TAG_TIMEOUT_1' }, 'timed out waiting for message');
        logger.warn('LIDs are not supported with onWhatsApp');
        logger.warn({ error: 'TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13' }, 'failed to sync critical_unblock_low from v0, giving up');
        logger.warn({ error: 'TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13' }, 'failed to sync regular from v0, giving up');
        logger.warn(
            { attrs: { from: '120363000000000001@g.us', error: '475', class: 'message' } },
            'received error in ack'
        );
        assert.equal(captured.length, 0);

        // App-state missing key triggers active recovery hook even when parked warnings across all 5 collections are suppressed
        logger.warn(
            { error: 'Error: failed to find key "AAAAAHGA" to decode mutation\n    at getKey (chat-utils.js:250:19)', statusCode: 500 },
            'critical_block blocked on missing key from v0, parking after 2 attempts'
        );
        logger.warn(
            { error: 'Error: failed to find key "AAAAAHGA" to decode mutation\n    at getKey (chat-utils.js:250:19)', statusCode: 500 },
            'regular_low blocked on missing key from v0, parking after 2 attempts'
        );
        assert.deepEqual(missingKeys, ['AAAAAHGA', 'AAAAAHGA']);
        assert.equal(captured.length, 0);

        // Stack frames in error strings are stripped on emitted Baileys errors
        logger.error(
            { error: 'Error: Stream errored out\n    at onError (socket.js:12:3)', from: '120363399604046397@g.us' },
            'app state sync failed'
        );
        assert.equal(captured.length, 1);
        assert.ok(!captured[0].includes('at onError'));

        // Non-network app-state failure still surfaces warning
        logger.warn(
            { error: 'Error: Invalid patch mac' },
            'failed to sync critical_block from v0, giving up'
        );
        assert.equal(captured.length, 2);

        // Volatile keyId values are normalized so sibling non-transient decrypt failures throttle cleanly
        logger.error('failed to decrypt message | Unsupported envelope for keyId=101, group=120363399604046397@g.us::254712345678_1::0');
        logger.error('failed to decrypt message | Unsupported envelope for keyId=202, group=120363399604046397@g.us::254712345678_1::0');
        assert.equal(captured.length, 3);

        const joined = captured.join('\n');
        assert.ok(!joined.includes('254712345678'), 'Phone digits must stay redacted');

        const diag = logger.getDiagnostics();
        assert.equal(diag.warnings, 10);
        assert.equal(diag.errors, 12);

        // Structured attrs/key fields are extracted & redacted when onEvent inspects events
        const events = [];
        const eventLogger = createBaileysSignalLogger({ onEvent: (ev) => events.push(ev) });
        eventLogger.warn({ attrs: { from: '254712345678@s.whatsapp.net', class: 'message', error: '475' } }, 'received error in ack');
        eventLogger.error({ key: { remoteJid: '123456789012@lid' }, err: new Error('Invalid PreKey ID') }, 'failed to decrypt message');
        assert.ok(events[0].summary.includes('from=••••78@s.whatsapp.net'));
        assert.ok(events[0].summary.includes('ackError=475'));
        assert.ok(events[1].summary.includes('jid=••••12@lid'));
    });
});

test('isLibsignalConsoleNoise and installConsoleSignalSanitizer suppress raw libsignal dumps and sanitize console strings', () => {
    assert.equal(isLibsignalConsoleNoise(['Failed to decrypt message with any known session...']), true);
    assert.equal(
        isLibsignalConsoleNoise([
            'Session error:Error: Bad MAC Error: Bad MAC\n    at Object.verifyMAC (/app/node_modules/libsignal/src/crypto.js:87:15)'
        ]),
        true
    );
    assert.equal(isLibsignalConsoleNoise([{ _chains: {}, currentRatchet: {} }]), true);
    assert.equal(isLibsignalConsoleNoise(['Closing open session in favor of incoming prekey bundle']), true);
    assert.equal(isLibsignalConsoleNoise(['Opening session:', { indexInfo: {}, registrationId: 98 }]), true);
    assert.equal(isLibsignalConsoleNoise(['Normal error for 254712345678@s.whatsapp.net']), false);

    const prevError = console.error;
    const prevWarn = console.warn;
    const prevInfo = console.info;
    const prevInstalled = console.__spiderSignalSanitizerInstalled;
    const emitted = [];
    try {
        delete console.__spiderSignalSanitizerInstalled;
        console.error = (...args) => emitted.push(['error', ...args]);
        console.warn = (...args) => emitted.push(['warn', ...args]);
        console.info = (...args) => emitted.push(['info', ...args]);

        assert.equal(installConsoleSignalSanitizer(), true);
        console.error('Failed to decrypt message with any known session...');
        console.error('Session error:', new Error('Bad MAC'));
        console.info('Closing session:', { _chains: {}, currentRatchet: {}, indexInfo: {}, registrationId: 98 });
        console.info('Opening session:', { currentRatchet: {} });
        console.warn('Session already closed', { _chains: {} });
        console.warn('Timeout contacting 254712345678@s.whatsapp.net');

        assert.equal(emitted.length, 1);
        assert.equal(emitted[0][0], 'warn');
        assert.ok(!String(emitted[0][1]).includes('254712345678'));
        assert.ok(String(emitted[0][1]).includes('••••78@s.whatsapp.net'));
    } finally {
        console.error = prevError;
        console.warn = prevWarn;
        console.info = prevInfo;
        if (prevInstalled === undefined) {
            delete console.__spiderSignalSanitizerInstalled;
        } else {
            console.__spiderSignalSanitizerInstalled = prevInstalled;
        }
    }
});

