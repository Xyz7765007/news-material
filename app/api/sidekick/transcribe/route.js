import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK TRANSCRIBE ENDPOINT
// POST /api/sidekick/transcribe
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Voice note → text. Lives HERE, not in sidekick-chat, for one reason:
// OPENAI_API_KEY already exists in this repo's env. The chat app has no
// OpenAI key and doesn't need one — it just posts the audio here with the
// Bearer token it already carries. No new credential anywhere.
//
// (Claude has no speech-to-text — the Messages API takes text, images and
// PDFs only — so transcription is the one job that can't run on Anthropic.
// Everything downstream of this, the drafting and refining, still does.)
//
// Body: { audio: "<base64>", mime?: "audio/ogg" }
// Returns: { ok, text }
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-1";

// WhatsApp caps voice notes well below this; 24MB is Whisper's own ceiling.
const MAX_BYTES = 24 * 1024 * 1024;

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false; // fail closed
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

export async function POST(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing OPENAI_API_KEY" }, { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

  const b64 = body?.audio;
  if (!b64 || typeof b64 !== "string") {
    return NextResponse.json({ ok: false, error: "audio (base64) required" }, { status: 400 });
  }

  let buffer;
  try { buffer = Buffer.from(b64, "base64"); }
  catch { return NextResponse.json({ ok: false, error: "audio is not valid base64" }, { status: 400 }); }

  if (!buffer.length || buffer.length > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `audio must be 1..${MAX_BYTES} bytes` }, { status: 413 });
  }

  const mime = String(body?.mime || "audio/ogg");

  try {
    const form = new FormData();
    // WhatsApp sends Opus-in-Ogg. Whisper sniffs the container, but it rejects
    // the part outright without a filename carrying a real extension.
    const ext = mime.includes("mp4") || mime.includes("mpeg") ? "m4a" : "ogg";
    form.append("file", new Blob([buffer], { type: mime }), `voice.${ext}`);
    form.append("model", TRANSCRIBE_MODEL);

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[TRANSCRIBE] OpenAI error:", r.status, t.slice(0, 200));
      return NextResponse.json({ ok: false, error: `Transcription failed (${r.status})` }, { status: 502 });
    }

    const data = await r.json();
    const text = String(data?.text || "").trim();
    if (!text) {
      return NextResponse.json({ ok: false, error: "Empty transcript" }, { status: 422 });
    }
    return NextResponse.json({ ok: true, text });
  } catch (e) {
    console.error("[TRANSCRIBE] Exception:", e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
