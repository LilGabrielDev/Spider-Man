import fs from 'fs';
import path from 'path';
import { tmpdir as _0xzipTmpdir } from 'os';
import { fileURLToPath } from 'url';
import { ZipArchive } from 'archiver';
import { t } from '../france/translator.js';
import { safeDeleteTempMessage } from '../../spider/utils/groupActionHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const commands = [
  {
    name: 'zip',
    aliases: ['botzip', 'downloadbot', 'getbot', 'exportbot', 'zipbot'],
    description: 'Download the entire bot as a ZIP file (Owner only)',
    category: 'Owner',
    ownerOnly: true,
    execute: async ({ sock, from, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const creatingMsg = await t(from, 'zip', 'creating');
      const tempMsg = await sock.sendMessage(from, { text: creatingMsg }, { quoted: msg });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${botName}-Backup-${timestamp}.zip`;
      const zipPath = path.join(_0xzipTmpdir(), fileName);

      try {
        const output = fs.createWriteStream(zipPath);
        const archive = new ZipArchive({ zlib: { level: 9 } });

        output.on('close', async () => {
          try {
            const bytes = archive.pointer();
            const sizeMb = (bytes / 1024 / 1024).toFixed(2);
            await safeDeleteTempMessage(sock, from, tempMsg);

            if (bytes > 50 * 1024 * 1024) {
              const tooLarge = await t(from, 'zip', 'tooLarge');
              const powered = await t(from, 'zip', 'powered');
              await sock.sendMessage(
                from,
                { text: `${tooLarge.replace('{size}', sizeMb)}\n\n${powered} ${botName}` },
                { quoted: msg },
              );
              return;
            }

            const successMsg = await t(from, 'zip', 'success');
            const powered = await t(from, 'zip', 'powered');
            await sock.sendMessage(
              from,
              { text: `${successMsg}\n\n📦 ${fileName}\n💾 ${sizeMb} MB\n📅 ${new Date().toLocaleString()}\n\n${powered} ${botName}` },
              { quoted: msg },
            );

            const captionPrefix = await t(from, 'zip', 'caption');
            await sock.sendMessage(
              from,
              {
                document: fs.readFileSync(zipPath),
                fileName,
                mimetype: 'application/zip',
                caption: `${captionPrefix}\nSize: ${sizeMb}MB`,
              },
              { quoted: msg },
            );
          } finally {
            try {
              if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            } catch {}
          }
        });

        archive.on('warning', (err) => {
          if (err.code === 'ENOENT') {
            console.warn('Archive warning:', err);
          } else {
            throw err;
          }
        });
        archive.on('error', (err) => {
          throw err;
        });

        archive.pipe(output);
        const ignoreDirs = ['node_modules', '.git', 'temp', 'tmp', 'logs', 'sessions', 'backups', 'uploads', 'cache'];
        const ignoreFiles = ['.env', '*.log', '*.zip', 'session.json', 'creds.json', 'package-lock.json'];
        archive.glob('**/*', {
          cwd: process.cwd(),
          ignore: ignoreDirs.map((dir) => `${dir}/**`).concat(ignoreFiles),
          dot: false,
        });
        await archive.finalize();
      } catch (err) {
        console.error('Backup error:', err);
        await safeDeleteTempMessage(sock, from, tempMsg);
        const errorMsg = await t(from, 'zip', 'error');
        const powered = await t(from, 'zip', 'powered');
        await sock.sendMessage(
          from,
          { text: `${errorMsg.replace('{error}', err.message)}\n\n${powered} ${botName}` },
          { quoted: msg },
        );
        if (fs.existsSync(zipPath)) {
          try {
            fs.unlinkSync(zipPath);
          } catch {}
        }
      }
    },
  },
];