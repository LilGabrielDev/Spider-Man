import { resolveParticipantRole } from "./groupRoleResolver.js";
import { executeParticipantsAction } from "./groupActionHelper.js";

const PROTECTED_ACTIONS = new Set(["add", "remove", "promote", "demote"]);

export function groupAdminActionDecision({ enabled = false, action = "", targets = [], metadata = null } = {}) {
  if (!enabled || !PROTECTED_ACTIONS.has(String(action).toLowerCase())) {
    return { allowed: true, reason: "protection-disabled-or-not-applicable" };
  }

  if (!metadata || !Array.isArray(metadata.participants) || metadata.participants.length === 0) {
    return { allowed: false, reason: "group-metadata-unavailable" };
  }

  const protectedTarget = (Array.isArray(targets) ? targets : [targets])
    .filter(Boolean)
    .some((target) => resolveParticipantRole(metadata, target).isAdmin);
  return protectedTarget
    ? { allowed: false, reason: "target-is-group-admin" }
    : { allowed: true, reason: "target-is-not-group-admin" };
}

export async function executeGroupAdminProtectedAction({
  enabled = false,
  sock,
  from,
  participants = [],
  action,
  metadata = null,
} = {}) {
  const targets = Array.isArray(participants) ? participants : [participants];
  const decision = groupAdminActionDecision({ enabled, action, targets, metadata });
  if (!decision.allowed) {
    return {
      ok: false,
      blocked: true,
      protectionReason: decision.reason,
      succeeded: [],
      failed: targets.map((jid) => ({ jid, status: decision.reason })),
      statusCodes: [],
      error: decision.reason,
    };
  }
  return executeParticipantsAction({ sock, from, participants: targets, action, metadata });
}
