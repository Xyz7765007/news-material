// ─── Connector kill-switches (Kunal's lever) ────────────────────────
// Single source of truth for turning whole connector FAMILIES on/off
// without a code change. Flip them in Vercel → Settings → Environment
// Variables, then redeploy (env vars only take effect on the next deploy).
//
// Set 2026-06-12 per Kunal's Jun-12 standup (item 10): LinkedIn connectors
// + LinkedIn DMs are OFF until Kunal supplies the proper prompt space.
//
// DEFAULT: OFF. A family is enabled ONLY when its env var is exactly the
// string "true" (case-insensitive). Any other value — including unset —
// keeps it OFF. This is the inverse of the ROLE_GATE_ENABLED convention
// (which defaults ON) because the operator intent here is "off until
// explicitly turned back on".
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
export const LINKEDIN_CONNECTORS_ENABLED = flagOn("LINKEDIN_CONNECTORS_ENABLED");

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
