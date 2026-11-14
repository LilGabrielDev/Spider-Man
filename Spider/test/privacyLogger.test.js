import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SILENT_LOGGER,
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
