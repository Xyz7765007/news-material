"use client";

import { useEffect, useState } from "react";
import SignalScope from "@/components/SignalScope";

// ═══════════════════════════════════════════════════════════════════
// Admin portal gate — backend-validated.
//
// The actual password lives server-side in ADMIN_PASSWORD env var
// (see /api/admin-auth/route.js). This component:
//   1. Submits typed password to /api/admin-auth (login)
//   2. Receives an HMAC-signed token back on success
//   3. Stores ONLY THE TOKEN in sessionStorage — not the password
//   4. On next page load, sends the token to /api/admin-auth (verify)
//      which re-checks the HMAC + expiry server-side
//
// So someone inspecting the JS bundle sees:
//   - The fetch call to /api/admin-auth
//   - The token in sessionStorage (if logged in)
// They DON'T see the password — it never reaches the browser as a
// known string. Only the user typing it knows what it is.
//
// Only the root route (/) is gated. /client/[id] keeps its own
// per-campaign password.
// ═══════════════════════════════════════════════════════════════════

const SESSION_KEY = "ss_admin_token";

export default function Home() {
  // Three states:
  //   "checking" — initial paint, verifying any stored token
  //   "locked"   — show password prompt
  //   "ok"       — render SignalScope
  const [authState, setAuthState] = useState("checking");
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // On mount: if we have a stored token, verify it with the backend.
  // Backend re-checks HMAC + expiry — if invalid (tampered, expired,
  // password rotated), we wipe and re-prompt.
  useEffect(() => {
    let stored;
    try { stored = sessionStorage.getItem(SESSION_KEY); } catch {}
    if (!stored) {
      setAuthState("locked");
      return;
    }
    fetch("/api/admin-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", token: stored }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setAuthState("ok");
        } else {
          try { sessionStorage.removeItem(SESSION_KEY); } catch {}
          setAuthState("locked");
        }
      })
      .catch(() => {
        // Network error — fail closed (prompt for password rather
        // than letting through on optimistic-cached state).
        setAuthState("locked");
      });
  }, []);

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (submitting) return;
    if (!pwInput) { setPwError("Enter a password"); return; }
    setSubmitting(true);
    setPwError("");
    try {
      const r = await fetch("/api/admin-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password: pwInput }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && d.token) {
        try { sessionStorage.setItem(SESSION_KEY, d.token); } catch {}
        setAuthState("ok");
        setPwInput("");
      } else {
        setPwError(d.error || "Wrong password");
        setPwInput("");
      }
    } catch {
      setPwError("Network error — try again");
    } finally {
      setSubmitting(false);
    }
  };

  if (authState === "checking") {
    return <div style={{ minHeight: "100vh", background: "#0a0a0a" }} />;
  }

  if (authState === "locked") {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}>
        <form onSubmit={submit} style={{
          background: "#141414",
          border: "1px solid #2a2a2a",
          borderRadius: 12,
          padding: "32px 36px",
          width: 360,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: "#f0f0f0", marginBottom: 6 }}>
            🔒 SignalScope Admin
          </div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 22, lineHeight: 1.5 }}>
            Enter admin password to continue.
          </div>
          <input
            type="password"
            value={pwInput}
            onChange={(e) => { setPwInput(e.target.value); setPwError(""); }}
            autoFocus
            disabled={submitting}
            placeholder="Password"
            style={{
              width: "100%",
              padding: "10px 12px",
              background: "#0a0a0a",
              border: "1px solid " + (pwError ? "#c45c5c" : "#2a2a2a"),
              borderRadius: 6,
              color: "#f0f0f0",
              fontSize: 14,
              outline: "none",
              marginBottom: pwError ? 8 : 16,
              boxSizing: "border-box",
              opacity: submitting ? 0.6 : 1,
            }}
          />
          {pwError && (
            <div style={{ color: "#c45c5c", fontSize: 11, marginBottom: 16 }}>
              {pwError}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            style={{
              width: "100%",
              padding: "10px 16px",
              background: "#d4a943",
              color: "#0a0a0a",
              border: "none",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Checking..." : "Enter"}
          </button>
          <div style={{ marginTop: 18, fontSize: 10, color: "#555", lineHeight: 1.5 }}>
            Client portal users — your login goes through the campaign-specific URL your account manager sent you, not this page.
          </div>
        </form>
      </div>
    );
  }

  return <SignalScope />;
}
