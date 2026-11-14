import { resolveParticipantRole } from "./groupRoleResolver.js";

const PROTECTED_ACTIONS = new Set(["add", "remove", "promote", "demote"]);

export function groupAdminActionDecision({ enabled = false, action = "", targets = [], metadata = null } = {}) {
  if (!enabled || !PROTECTED_ACTIONS.has(String(action).toLowerCase())) {
    return { allowed: true, reason: "protection-disabled-or-not-applicable" };
  }

  const protectedTarget = (Array.isArray(targets) ? targets : [targets])
    .filter(Boolean)
    .some((target) => resolveParticipantRole(metadata, target).isAdmin);
  return protectedTarget
    ? { allowed: false, reason: "target-is-group-admin" }
    : { allowed: true, reason: "target-is-not-group-admin" };
}
