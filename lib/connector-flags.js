// ─── Connector kill-switches (Kunal's lever) ────────────────────────
// Single source of truth for turning whole connector FAMILIES on/off
// without a code change. Flip them in Vercel → Settings → Environment
// Variables, then redeploy (env vars only take effect on the next deploy).
//
// Set 2026-06-12 per Kunal's Jun-12 standup (item 10): LinkedIn connectors
// + LinkedIn DMs are OFF until Kunal supplies the proper prompt space.
//
// DEFAULTS (per family, as of 2026-06-15):
//   LINKEDIN_CONNECTORS_ENABLED → defaults ON (re-enabled by Samarth; disable
//     with the literal "false"). Follows the ROLE_GATE_ENABLED convention.
//   LINKEDIN_DMS_ENABLED        → defaults OFF (Kunal's Jun-12 hold stands).
//     Enabled ONLY when its env var is exactly "true" (case-insensitive);
//     any other value — including unset — keeps it OFF.
//
//   LINKEDIN_CONNECTORS_ENABLED  → the LinkedIn Posts engagement connector
//                                  (/api/linkedin-posts scan + cron resume).
//   LINKEDIN_DMS_ENABLED         → LinkedIn DM + connection-request SENDS
//                                  (/api/outreach send/queue actions, the
//                                   4-hourly outreach cron that calls them,
//                                   and the chatbot auto-batch DM generator).
//
// HOW KUNAL FLIPS IT BACK ON (per family):
//   1. Vercel project (news-material) → Settings → Environment Variables
//   2. Add/edit  LINKEDIN_CONNECTORS_ENABLED=true  and/or  LINKEDIN_DMS_ENABLED=true
//   3. Redeploy (env changes are picked up on the next deployment only).
//   To turn OFF again: set the value to anything else (or delete the var).

function flagOn(name) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

// LinkedIn Posts engagement connector (the "connector" / data-in side).
// Re-enabled by Samarth 2026-06-15: the Jun-12 OFF state was treated as an
// inadvertent stop (Veloka posts fetch was never meant to be paused), not the
// intended "pending prompt space" hold. This flag now defaults ON — turn it OFF
// again with LINKEDIN_CONNECTORS_ENABLED=false. DMs (below) stay OFF-by-default.
export const LINKEDIN_CONNECTORS_ENABLED =
  String(process.env.LINKEDIN_CONNECTORS_ENABLED ?? "true").trim().toLowerCase() !== "false";

// LinkedIn DM + connection-request sending (the auto-send / outreach side).
export const LINKEDIN_DMS_ENABLED = flagOn("LINKEDIN_DMS_ENABLED");

// Shared 403 payload so every gated route returns an identical, explainable shape.
export function connectorDisabledResponse(family) {
  const which = family === "dms" ? "LinkedIn DMs" : "LinkedIn connectors";
  const envVar = family === "dms" ? "LINKEDIN_DMS_ENABLED" : "LINKEDIN_CONNECTORS_ENABLED";
  return {
    ok: false,
    error: `${which} are currently turned OFF.`,
    disabled: true,
    family,
    hint: `Set ${envVar}=true in Vercel env vars and redeploy to re-enable. (Off by default per Kunal Jun-12 standup — pending the proper prompt space.)`,
  };
}
