import { NextResponse } from "next/server";
import OpenAI from "openai";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK DIAGNOSE-AI
// GET /api/sidekick/diagnose-ai?key=<CRON_SECRET>
//
// Auto-batch personalization has been silently falling back to
// deterministic templates (every lead getting the same "noticed your
// work at X" connection note). Three things can cause that:
//   1. OPENAI_API_KEY env var missing on Vercel
//   2. OpenAI API call throws (bad model name, expired key, rate
//      limit, network error) — caught at line 415 of generate route
//   3. AI returns empty / invalid JSON → every field falls back
//   4. Validation rejects the AI output (merge field leak, refusal,
//      char limit, internal-leak phrase) → falls back
//
// This endpoint isolates which one is happening. It does a minimal
// JSON-mode call with the SAME model the auto-batch uses, returns
// the raw response, and reports any error verbatim.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Mirror the model the auto-batch uses. Override via ?model=... to
// test alternatives without redeploying.
const DEFAULT_MODEL = "gpt-5.4-mini";

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized — pass ?key=<CRON_SECRET>" }, { status: 401 });
  }

  const model = url.searchParams.get("model") || DEFAULT_MODEL;

  const report = {
    ok: false,
    model,
    checks: {
      openaiKeyPresent: !!OPENAI_KEY,
      openaiKeyLength: OPENAI_KEY ? OPENAI_KEY.length : 0,
      // Sanity check on the key format. Don't log the key itself.
      openaiKeyPrefix: OPENAI_KEY ? `${OPENAI_KEY.slice(0, 7)}…` : null,
    },
  };

  if (!OPENAI_KEY) {
    report.error = "OPENAI_API_KEY env var not set on this deployment. Auto-batch will ALWAYS fall back to deterministic templates until this is fixed.";
    report.fix = "Set OPENAI_API_KEY in Vercel project settings → Environment Variables → redeploy";
    return NextResponse.json(report, { status: 200 });
  }

  // Minimal test call mirroring auto-batch invocation. Forces JSON mode,
  // tiny token budget — fastest way to confirm key+model+JSON output work.
  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  let resp;
  try {
    resp = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Return ONLY valid JSON of the form {\"ping\": \"pong\"}." },
        { role: "user", content: "ping" },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 50,
    });
  } catch (e) {
    report.error = "OpenAI API call FAILED — this is why auto-batch falls back. See raw error below.";
    report.rawError = e.message || String(e);
    report.errorStatus = e.status || null;
    report.errorCode = e.code || null;
    // Common cases we can hint at
    if (/invalid.*api.*key|incorrect.*api.*key/i.test(report.rawError)) {
      report.fix = "API key is invalid or revoked. Get a fresh one from platform.openai.com → API keys → set in Vercel → redeploy.";
    } else if (/model.*not.*found|does not exist/i.test(report.rawError)) {
      report.fix = `Model "${model}" doesn't exist or your account lacks access. Try a known-good model: ?model=gpt-4o-mini`;
    } else if (/rate.*limit|quota/i.test(report.rawError)) {
      report.fix = "Hit a rate limit or quota cap. Check OpenAI billing + usage.";
    }
    return NextResponse.json(report, { status: 200 });
  }

  const rawContent = resp.choices?.[0]?.message?.content || "";
  report.checks.openaiCallSucceeded = true;
  report.checks.rawContent = rawContent;
  report.checks.usage = resp.usage || null;

  let parsed;
  try { parsed = JSON.parse(rawContent || "{}"); }
  catch (e) {
    report.error = "AI returned invalid JSON. If this happens with auto-batch too, every draft falls back.";
    report.parseError = e.message;
    return NextResponse.json(report, { status: 200 });
  }

  if (!parsed || Object.keys(parsed).length === 0) {
    report.error = "AI returned empty JSON object. max_completion_tokens too low? Try ?model=gpt-4o-mini to compare.";
    return NextResponse.json(report, { status: 200 });
  }

  report.ok = true;
  report.checks.parsedJson = parsed;
  report.message = `OpenAI key + model "${model}" are working. If auto-batch still falls back, the issue is validation (merge-field leak, refusal, char limit, or internal-leak phrase) — check the "AI Debug" field on a recent Outreach record.`;
  return NextResponse.json(report, { status: 200 });
}
