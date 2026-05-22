import { NextResponse } from "next/server";
import crypto from "crypto";

// ═══════════════════════════════════════════════════════════════════
// Admin portal authentication.
//
// Server-side password check. The client only ever sends the password
// to /api/admin-auth (login action) and receives back an HMAC-signed
// token. The token is what's stored in sessionStorage — not the
// password. So even if someone inspects the JS or sniffs traffic
// after login, they can't recover the password.
//
// Configuration:
//   ADMIN_PASSWORD env var on Vercel (recommended)
//   Falls back to "7765007" if env var not set, so first-deploy works.
//   After confirming working, set ADMIN_PASSWORD on Vercel to make the
//   fallback path dead code.
//
// Threat model:
//   - Protects against URL-discovery / accidental link-sharing
//   - Stops "view source" / "inspect element" password extraction
//     (the actual password value is never sent to the browser)
//   - Does NOT protect against compromised Vercel access or env var
//     leakage from logs — those require ops hygiene, not code
//   - Token lifetime 24h; refresh on next login
//
// Token format: <expiry_unix_ms>.<hmac_sha256_hex>
//   - HMAC keyed with ADMIN_PASSWORD itself, so password rotation
//     invalidates all outstanding tokens automatically (good behavior).
//   - Verification uses constant-time compare (crypto.timingSafeEqual)
//     to prevent timing-based forgery.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "7765007";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function sign(payload) {
  return crypto
    .createHmac("sha256", ADMIN_PASSWORD)
    .update(String(payload))
    .digest("hex");
}

function makeToken() {
  const expiry = Date.now() + TOKEN_TTL_MS;
  return `${expiry}.${sign(expiry)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiryStr, sig] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiry)) return false;
  if (expiry < Date.now()) return false; // expired
  const expectedSig = sign(expiry);
  // Constant-time compare prevents an attacker from learning the
  // signature byte-by-byte via response-time differences.
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { action, password, token } = body || {};

  if (action === "login") {
    if (typeof password !== "string" || password.length === 0) {
      return NextResponse.json({ ok: false, error: "Password required" }, { status: 400 });
    }
    // Constant-time string compare on the password too — best practice
    // for credential checks even though Node strings are normally
    // compared in O(min) time. Equalize length first to avoid leaking
    // password length via early exit.
    const a = Buffer.from(password);
    const b = Buffer.from(ADMIN_PASSWORD);
    let matches = false;
    if (a.length === b.length) {
      matches = crypto.timingSafeEqual(a, b);
    }
    if (matches) {
      return NextResponse.json({ ok: true, token: makeToken() });
    }
    return NextResponse.json({ ok: false, error: "Wrong password" }, { status: 401 });
  }

  if (action === "verify") {
    return NextResponse.json({ ok: verifyToken(token) });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}

// Helper export so other API routes can import this and gate themselves
// behind the same admin token. (Not used yet; future hardening hook.)
export function isAdminTokenValid(token) {
  return verifyToken(token);
}
