const DEFAULT_EMOJIS = ["🐾", "⚡", "💜"];

export function isSingleEmoji(value) {
  return typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= 2;
}

export function normalizeStatusReaction(value) {
  const normalized = String(value || "random").trim();
  return normalized === "random" || isSingleEmoji(normalized) ? normalized : "random";
}

export function chooseStatusReactionEmoji(value = "random") {
  const normalized = normalizeStatusReaction(value);
  if (normalized !== "random") return normalized;
  return DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
}
