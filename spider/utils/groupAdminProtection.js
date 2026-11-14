const PROTECTED_ACTIONS = new Set(["add", "remove", "promote", "demote"]);

export function groupAdminActionDecision({ enabled = false, action = "", targets = [], metadata = null } = {}) {
  if (!enabled || !PROTECTED_ACTIONS.has(String(action).toLowerCase())) {
    return { allowed: true, reason: "protection-disabled-or-not-applicable" };
  }

  const admins = new Set(
    (metadata?.participants ?? [])
      .filter((participant) => participant?.admin === "admin" || participant?.admin === "superadmin")
      .flatMap((participant) => [participant.id, participant.jid, participant.pn, participant.phoneNumber])
      .filter(Boolean),
  );
  const protectedTarget = targets.some((target) => admins.has(target));
  return protectedTarget
    ? { allowed: false, reason: "target-is-group-admin" }
    : { allowed: true, reason: "target-is-not-group-admin" };
}
