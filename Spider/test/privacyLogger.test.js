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

test('createBaileysSignalLogger filters redundant rollback/newsletter noise, normalizes keyId dedupe, and notifies missing app-state keys', async () => {
    await withCapturedConsole((captured) => {
        const missingKeys = [];
        const logger = createBaileysSignalLogger({
            throttleMs: 60_000,
            onMissingAppStateKey: (kid) => missingKeys.push(kid)
        });

        // Redundant rollback and benign newsletter notifications stay silent while still tracked
        logger.error({ err: new Error('No session found to decrypt message') }, 'transaction failed, rolling back');
        logger.warn('Invalid mex newsletter notification content');
        assert.equal(captured.length, 0);

        // App-state missing key triggers active recovery hook
        logger.warn(
            { err: new Error('failed to find key "AAAAAHGA" to decode mutation') },
            'regular_low blocked on missing key from v0, parking after 2 attempts'
        );
        assert.deepEqual(missingKeys, ['AAAAAHGA']);
        assert.equal(captured.length, 1);

        // Volatile keyId values are normalized so sibling group decrypt failures throttle cleanly
        logger.error('failed to decrypt message | No session found to decrypt message for keyId=101, group=status@broadcast::254712345678_1::0');
        logger.error('failed to decrypt message | No session found to decrypt message for keyId=202, group=status@broadcast::254712345678_1::0');
        assert.equal(captured.length, 2);

        const joined = captured.join('\n');
        assert.ok(!joined.includes('254712345678'), 'Phone digits must stay redacted');

        const diag = logger.getDiagnostics();
        assert.equal(diag.warnings, 2);
        assert.equal(diag.errors, 3);
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
    assert.equal(isLibsignalConsoleNoise(['Normal error for 254712345678@s.whatsapp.net']), false);

    const prevError = console.error;
    const prevWarn = console.warn;
    const prevInstalled = console.__spiderSignalSanitizerInstalled;
    const emitted = [];
    try {
        delete console.__spiderSignalSanitizerInstalled;
        console.error = (...args) => emitted.push(['error', ...args]);
        console.warn = (...args) => emitted.push(['warn', ...args]);

        assert.equal(installConsoleSignalSanitizer(), true);
        console.error('Failed to decrypt message with any known session...');
        console.error('Session error:', new Error('Bad MAC'));
        console.warn('Timeout contacting 254712345678@s.whatsapp.net');

        assert.equal(emitted.length, 1);
        assert.equal(emitted[0][0], 'warn');
        assert.ok(!String(emitted[0][1]).includes('254712345678'));
        assert.ok(String(emitted[0][1]).includes('••••78@s.whatsapp.net'));
    } finally {
        console.error = prevError;
        console.warn = prevWarn;
        if (prevInstalled === undefined) {
            delete console.__spiderSignalSanitizerInstalled;
        } else {
            console.__spiderSignalSanitizerInstalled = prevInstalled;
        }
    }
});

