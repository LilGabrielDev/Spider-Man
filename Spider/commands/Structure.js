import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { t } from '../france/translator.js';
import configDefault from '../../spider/config.js';
import { spiderHeader, spiderRow, spiderDivider, spiderFooter } from '../utils/tableStyle.js';
import { safeDeleteTempMessage } from '../../spider/utils/groupActionHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const commands = [
  {
    name: 'structure',
    aliases: ['tree'],
    description: 'Analyze the complete structure, files, and folders of the bot',
    category: 'Owner',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config?.BOT_NAME || configDefault?.BOT_NAME || 'Spider Man';
      const tokens = String(text || '').trim().split(/\s+/);
      const sub = tokens[0]?.toLowerCase() || '';

      if (sub === 'help') {
        const helpTitle = await t(from, 'structure', 'helpTitle');
        const cmdDefault = await t(from, 'structure', 'cmdDefault');
        const cmdTree = await t(from, 'structure', 'cmdTree');
        const cmdDetails = await t(from, 'structure', 'cmdDetails');
        const cmdSize = await t(from, 'structure', 'cmdSize');
        const cmdFiles = await t(from, 'structure', 'cmdFiles');
        const cmdTreeAlias = await t(from, 'structure', 'cmdTreeAlias');
        const powered = await t(from, 'structure', 'powered');
        return sock.sendMessage(
          from,
          {
            text: `${helpTitle}\n\n${cmdDefault}\n${cmdTree}\n${cmdDetails}\n${cmdSize}\n${cmdFiles}\n${cmdTreeAlias}\n\n${powered} ${botName}`,
          },
          { quoted: msg },
        );
      }

      const analyzingMsg = await t(from, 'structure', 'analyzing');
      const tempMsg = await sock.sendMessage(from, { text: analyzingMsg }, { quoted: msg });

      try {
        const rootDir = process.cwd();
        const ignoredDirs = ['node_modules', '.git', 'temp', 'tmp', 'logs', 'sessions', 'backups', 'uploads', 'cache', 'sessions', 'venv', 'env', '__pycache__'];
        const ignoredFiles = ['.env', '*.log', '*.zip', 'session.json', 'creds.json', 'package-lock.json', 'yarn.lock'];
        const stats = {
          totalFiles: 0,
          totalFolders: 0,
          totalSize: 0,
          byExtension: {},
          byFolder: {},
          files: [],
          tree: '',
        };

        const buildTree = (dirPath, prefix = '') => {
          if (!fs.existsSync(dirPath)) return '';
          const items = fs.readdirSync(dirPath).filter((name) => {
            const fullPath = path.join(dirPath, name);
            const st = fs.statSync(fullPath);
            if (st.isDirectory()) {
              return !ignoredDirs.includes(name) && !name.startsWith('.');
            }
            const isIgnored = ignoredFiles.some((pattern) => {
              if (pattern.includes('*')) {
                const regex = new RegExp(pattern.replace('*', '.*'));
                return regex.test(name);
              }
              return name === pattern;
            });
            return !isIgnored;
          });

          items.sort((a, b) => {
            const fullA = path.join(dirPath, a);
            const fullB = path.join(dirPath, b);
            const dirA = fs.statSync(fullA).isDirectory();
            const dirB = fs.statSync(fullB).isDirectory();
            if (dirA && !dirB) return -1;
            if (!dirA && dirB) return 1;
            return a.localeCompare(b);
          });

          let out = '';
          for (let i = 0; i < items.length; i++) {
            const name = items[i];
            const fullPath = path.join(dirPath, name);
            const st = fs.statSync(fullPath);
            const isLast = i === items.length - 1;
            const branch = isLast ? '└── ' : '├── ';
            const nextPrefix = prefix + (isLast ? '    ' : '│   ');
            if (st.isDirectory()) {
              out += `${prefix}${branch}📁 ${name}/\n`;
              out += buildTree(fullPath, nextPrefix);
            } else {
              const kb = (st.size / 1024).toFixed(1);
              out += `${prefix}${branch}📄 ${name} (${kb} KB)\n`;
            }
          }
          return out;
        };

        const walkStats = (dirPath, relFolder = '') => {
          if (!fs.existsSync(dirPath)) return { files: 0, size: 0 };
          const entries = fs.readdirSync(dirPath);
          let folderFiles = 0;
          let folderSize = 0;
          for (const name of entries) {
            const fullPath = path.join(dirPath, name);
            const st = fs.statSync(fullPath);
            if (st.isDirectory()) {
              if (!ignoredDirs.includes(name) && !name.startsWith('.')) {
                stats.totalFolders++;
                const subStats = walkStats(fullPath, path.join(relFolder, name));
                folderFiles += subStats.files;
                folderSize += subStats.size;
              }
            } else {
              const ext = path.extname(name).toLowerCase() || 'no extension';
              const isIgnored = ignoredFiles.some((pattern) => {
                if (pattern.includes('*')) {
                  const regex = new RegExp(pattern.replace('*', '.*'));
                  return regex.test(name);
                }
                return name === pattern;
              });
              if (!isIgnored) {
                stats.totalFiles++;
                stats.totalSize += st.size;
                folderFiles++;
                folderSize += st.size;
                stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
                stats.files.push({
                  name,
                  path: path.join(relFolder, name),
                  size: st.size,
                  ext,
                  modified: st.mtime,
                });
              }
            }
          }
          if (relFolder && (folderFiles > 0 || folderSize > 0)) {
            stats.byFolder[relFolder] = { files: folderFiles, size: folderSize };
          }
          return { files: folderFiles, size: folderSize };
        };

        walkStats(rootDir);

        if (sub === 'tree' || String(text || '').trim() === 'tree') {
          const treeStr = buildTree(rootDir);
          await safeDeleteTempMessage(sock, from, tempMsg);
          const treeHeader = await t(from, 'structure', 'treeHeader');
          const powered = await t(from, 'structure', 'powered');
          let reply = `${treeHeader}\n\n📁 ${path.basename(rootDir)}/\n`;
          reply += treeStr || 'No files found\n';
          reply += `\n${powered} ${botName}`;
          if (reply.length > 3500) {
            const chunks = reply.match(/[\s\S]{1,3500}/g) || [];
            const continued = await t(from, 'structure', 'continued');
            for (let i = 0; i < chunks.length; i++) {
              await sock.sendMessage(
                from,
                { text: chunks[i] + (i < chunks.length - 1 ? `\n\n${continued}` : '') },
                { quoted: msg },
              );
            }
          } else {
            await sock.sendMessage(from, { text: reply }, { quoted: msg });
          }
          return;
        }

        if (sub === 'details') {
          const largest = [...stats.files].sort((a, b) => b.size - a.size).slice(0, 20);
          const detailsHeader = await t(from, 'structure', 'detailsHeader');
          const totalFilesLbl = await t(from, 'structure', 'totalFiles');
          const totalFoldersLbl = await t(from, 'structure', 'totalFolders');
          const totalSizeLbl = await t(from, 'structure', 'totalSize');
          const largestFilesLbl = await t(from, 'structure', 'largestFiles');
          const powered = await t(from, 'structure', 'powered');

          let reply = `${detailsHeader}\n\n`;
          reply += `${totalFilesLbl} ${stats.totalFiles}\n`;
          reply += `${totalFoldersLbl} ${stats.totalFolders}\n`;
          reply += `${totalSizeLbl} ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB\n\n`;
          reply += `${largestFilesLbl}\n`;
          for (let i = 0; i < largest.length; i++) {
            const file = largest[i];
            const kb = (file.size / 1024).toFixed(1);
            reply += `${i + 1}. ${file.path}\n`;
            reply += `   💾 ${kb} KB | 📝 ${file.ext}\n`;
            reply += `   🕒 ${file.modified.toLocaleDateString()}\n\n`;
          }
          reply += `${powered} ${botName}`;

          await safeDeleteTempMessage(sock, from, tempMsg);
          if (reply.length > 3500) {
            const chunks = reply.match(/[\s\S]{1,3500}/g) || [];
            const continued = await t(from, 'structure', 'continued');
            for (let i = 0; i < chunks.length; i++) {
              await sock.sendMessage(
                from,
                { text: chunks[i] + (i < chunks.length - 1 ? `\n\n${continued}` : '') },
                { quoted: msg },
              );
            }
          } else {
            await sock.sendMessage(from, { text: reply }, { quoted: msg });
          }
          return;
        }

        if (sub === 'size') {
          const folders = Object.entries(stats.byFolder)
            .sort((a, b) => b[1].size - a[1].size)
            .slice(0, 20);
          const sizeHeader = await t(from, 'structure', 'sizeHeader');
          const totalSizeLbl = await t(from, 'structure', 'totalSize');
          const totalFilesLbl = await t(from, 'structure', 'totalFiles');
          const largestFoldersLbl = await t(from, 'structure', 'largestFolders');
          const powered = await t(from, 'structure', 'powered');

          let reply = `${sizeHeader}\n\n`;
          reply += `${totalSizeLbl} ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB\n`;
          reply += `${totalFilesLbl} ${stats.totalFiles}\n\n`;
          reply += `${largestFoldersLbl}\n`;
          for (let i = 0; i < folders.length; i++) {
            const [folderName, folderStats] = folders[i];
            const mb = (folderStats.size / 1024 / 1024).toFixed(2);
            const pct = stats.totalSize > 0 ? ((folderStats.size / stats.totalSize) * 100).toFixed(1) : '0.0';
            reply += `${i + 1}. 📁 ${folderName || 'root'}\n`;
            reply += `   💾 ${mb} MB (${pct}%)\n`;
            reply += `   📄 ${folderStats.files} files\n\n`;
          }
          reply += `${powered} ${botName}`;

          await safeDeleteTempMessage(sock, from, tempMsg);
          await sock.sendMessage(from, { text: reply }, { quoted: msg });
          return;
        }

        if (sub === 'files') {
          const exts = Object.entries(stats.byExtension).sort((a, b) => b[1] - a[1]);
          const filesHeader = await t(from, 'structure', 'filesHeader');
          const totalFilesLbl = await t(from, 'structure', 'totalFiles');
          const totalSizeLbl = await t(from, 'structure', 'totalSize');
          const powered = await t(from, 'structure', 'powered');

          let reply = `${filesHeader}\n\n`;
          for (const [ext, count] of exts) {
            const pct = stats.totalFiles > 0 ? ((count / stats.totalFiles) * 100).toFixed(1) : '0.0';
            reply += `📝 ${ext || 'no extension'}: ${count} files (${pct}%)\n`;
          }
          reply += `\n${totalFilesLbl} ${stats.totalFiles} files\n`;
          reply += `${totalSizeLbl} ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB\n`;
          reply += `\n${powered} ${botName}`;

          await safeDeleteTempMessage(sock, from, tempMsg);
          await sock.sendMessage(from, { text: reply }, { quoted: msg });
          return;
        }

        const topExts = Object.entries(stats.byExtension).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const largestFiles = [...stats.files].sort((a, b) => b.size - a.size).slice(0, 10);
        const analysisHeader = await t(from, 'structure', 'analysisHeader');
        const totalFoldersLbl = await t(from, 'structure', 'totalFolders');
        const totalFilesLbl = await t(from, 'structure', 'totalFiles');
        const totalSizeLbl = await t(from, 'structure', 'totalSize');
        const platformLbl = await t(from, 'structure', 'platform');
        const nodeLbl = await t(from, 'structure', 'node');
        const topExtLbl = await t(from, 'structure', 'topExtensions');
        const largestLbl = await t(from, 'structure', 'largestFiles');
        const tipsLbl = await t(from, 'structure', 'tips');
        const cmdDefault = await t(from, 'structure', 'cmdDefault');
        const cmdTree = await t(from, 'structure', 'cmdTree');
        const cmdDetails = await t(from, 'structure', 'cmdDetails');
        const cmdSize = await t(from, 'structure', 'cmdSize');
        const cmdFiles = await t(from, 'structure', 'cmdFiles');
        const cmdTreeAlias = await t(from, 'structure', 'cmdTreeAlias');
        const powered = await t(from, 'structure', 'powered');

        let reply = `${analysisHeader}\n\n`;
        reply += `${spiderHeader(configDefault.BOT_NAME || 'Spider Man', 'SYSTEM SCAN')}\n`;
        reply += `${spiderRow(totalFoldersLbl, stats.totalFolders, '▰')}\n`;
        reply += `${spiderRow(totalFilesLbl, stats.totalFiles, '▤')}\n`;
        reply += `${spiderRow(totalSizeLbl, `${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`, '◈')}\n`;
        reply += `${spiderRow(platformLbl, os.platform(), '⌖')}\n`;
        reply += `${spiderRow(nodeLbl, process.version, '⌘')}\n`;
        reply += `${spiderDivider()}\n`;
        reply += `${spiderFooter('SCAN COMPLETE')}\n\n`;
        reply += `${topExtLbl}\n`;
        for (const [ext, count] of topExts) {
          reply += `   ${ext || 'no ext'}: ${count} files\n`;
        }
        reply += '\n';
        reply += `${largestLbl}\n`;
        for (let i = 0; i < largestFiles.length; i++) {
          const f = largestFiles[i];
          reply += `   ${i + 1}. ${f.path} (${(f.size / 1024).toFixed(1)} KB)\n`;
        }
        reply += '\n';
        reply += `${tipsLbl}\n`;
        reply += `   • ${cmdDefault}\n`;
        reply += `   • ${cmdTree}\n`;
        reply += `   • ${cmdDetails}\n`;
        reply += `   • ${cmdSize}\n`;
        reply += `   • ${cmdFiles}\n`;
        reply += `   • ${cmdTreeAlias}\n`;
        reply += `\n${powered} ${botName}`;

        await safeDeleteTempMessage(sock, from, tempMsg);
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
      } catch (err) {
        console.error('Structure error:', err);
        await safeDeleteTempMessage(sock, from, tempMsg);
        const errMsg = await t(from, 'structure', 'error');
        const powered = await t(from, 'structure', 'powered');
        await sock.sendMessage(from, { text: `${errMsg}\n\n${powered} ${botName}` }, { quoted: msg });
      }
    },
  },
];