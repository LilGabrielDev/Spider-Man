import performanceNow from 'performance-now';
import config from '../../spider/config.js';

if (!globalThis.botStartTime) {
  globalThis.botStartTime = Date.now();
}

export const commands = [
  {
    name: 'ping',
    aliases: ['latency', 'speed'],
    description: "Checks the bot's response time",
    category: 'General',
    execute: async ({ sock, from, msg }) => {
      const startedAt = performanceNow();
      const botName = config.BOT_NAME || 'Spider Man';
      await sock.sendMessage(from, { text: 'Pinging...' }, { quoted: msg });
      const latencyMs = Math.round(performanceNow() - startedAt);
      return sock.sendMessage(
        from,
        { text: `🏓 Pong!\n⏱️ *_${botName} Speed: ${latencyMs} ms_*` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'uptime',
    aliases: ['runtime'],
    description: 'Displays the bot uptime',
    category: 'General',
    execute: async ({ sock, from, msg }) => {
      const elapsedMs = Date.now() - globalThis.botStartTime;
      const uptime = formatUptime(elapsedMs);
      const botName = config.BOT_NAME || 'Spider Man';
      return sock.sendMessage(
        from,
        { text: `*${botName} UPTIME: ${uptime}*` },
        { quoted: msg },
      );
    },
  },
];

function formatUptime(elapsedMs) {
  const seconds = Math.floor(elapsedMs / 1000) % 60;
  const minutes = Math.floor(elapsedMs / (1000 * 60)) % 60;
  const hours = Math.floor(elapsedMs / (1000 * 60 * 60)) % 24;
  const days = Math.floor(elapsedMs / (1000 * 60 * 60 * 24));
  const parts = [];

  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} m`);
  parts.push(`${seconds} s`);
  return parts.join(', ');
}
