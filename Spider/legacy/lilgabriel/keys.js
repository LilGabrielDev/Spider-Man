const SPIDER_API_KEY = process.env.SPIDER_API_KEY || '';
const SPIDER_API_FALLBACK = process.env.SPIDER_API_FALLBACK || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROQ_KEY_1 || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const failedGroqKeys = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;
let groqCursor = 0;

function getGroqKeyPool() {
  const candidates = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_KEY_1,
    process.env.GROQ_KEY_2,
    process.env.GROQ_KEY_3,
    process.env.GROQ_KEY_4,
    ...(String(process.env.GROQ_API_KEYS || '').split(/[,;\s]+/)),
  ]
    .map((k) => String(k || '').trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

function getNextGroqKey() {
  const pool = getGroqKeyPool();
  if (pool.length === 0) return '';
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const idx = (groqCursor + i) % pool.length;
    const candidate = pool[idx];
    const failedAt = failedGroqKeys.get(candidate) || 0;
    if (now - failedAt >= COOLDOWN_MS) {
      groqCursor = (idx + 1) % pool.length;
      return candidate;
    }
  }
  const fallback = pool[groqCursor % pool.length];
  groqCursor = (groqCursor + 1) % pool.length;
  return fallback;
}

function markKeyFailed(key) {
  const normalized = String(key || '').trim();
  if (normalized) {
    failedGroqKeys.set(normalized, Date.now());
  }
}

module.exports = {
  SPIDER_API_KEY,
  SPIDER_API_FALLBACK,
  GEMINI_API_KEY,
  OPENAI_API_KEY,
  GROQ_API_KEY,
  GITHUB_TOKEN,
  getNextGroqKey,
  markKeyFailed,
};