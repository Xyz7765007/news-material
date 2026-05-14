"use client";
import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Lead Movement Scan Modal
 *
 * Props:
 *   open: bool — show/hide modal
 *   onClose: () => void
 *   campaign: { airtableId, baseId } — current campaign
 *   leads: Lead[] — list of all loaded leads (used to derive Campaign Tag options + counts)
 *
 * Flow:
 *   1. On open → fetch preview (lead count + cost estimate, optionally filtered by tag)
 *   2. User picks Campaign Tag filter (or "All leads"), movement window, freshness skip
 *   3. User clicks Start → chunked scan loop
 *      - call /api/scan-leads with cursor=null, includes campaignTag if selected
 *      - on response, accumulate stats, update progress
 *      - if response.nextCursor, repeat with cursor=nextCursor
 *      - stop when done=true or user cancels
 *   4. Show final summary with link to Tasks
 */
export default function LeadMovementScanModal({ open, onClose, campaign, leads = [] }) {
  console.log("[LeadMovementScanModal] FUNCTION CALLED — open prop =", open, "campaign =", campaign);
  const [phase, setPhase] = useState("preview"); // preview | scanning | done | error
  const [preview, setPreview] = useState(null);
  const [windowDays, setWindowDays] = useState(90);
  const [freshnessSkipDays, setFreshnessSkipDays] = useState(7);
  const [campaignTag, setCampaignTag] = useState(""); // "" = all tags
  const [progress, setProgress] = useState({
    processed: { total: 0, hired: 0, promoted: 0, exited: 0, none: 0, stale: 0, unavailable: 0 },
    tasksCreated: 0,
    costUSD: 0,
    errors: [],
    batchesCompleted: 0,
  });
  const [errorMsg, setErrorMsg] = useState("");
  const [cancelRequested, setCancelRequested] = useState(false);
  // CRITICAL: each scan invocation gets its OWN local-cancel object.
  // Using a shared ref + state for cancellation has two bugs:
  //   (1) Closure capture — async loop captures cancelRequested at creation
  //       time, never sees state updates
  //   (2) Reset-on-reopen — if user closes mid-scan and reopens, useEffect
  //       resets the shared ref to false, accidentally "un-cancelling" the
  //       loop that's still running in the background
  // scanCancelRef.current points to the CURRENT scan's cancel object so the
  // Stop button always targets the in-flight scan, not stale ones.
  const scanCancelRef = useRef(null);

  const baseId = campaign?.baseId || "";
  const campaignId = campaign?.airtableId || "";

  // Derive available tags + counts from loaded leads
  const tagOptions = (() => {
    const counts = {};
    for (const l of leads) {
      const t = (l.fields || {})["Campaign Tag"];
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    return Object.keys(counts).sort().map(t => ({ name: t, count: counts[t] }));
  })();

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      console.log("[Movement Scan modal] open useEffect fired. baseId=", baseId, "campaignId=", campaignId, "leads.length=", leads.length);
      if (!baseId) {
        console.warn("[Movement Scan modal] ⚠️ baseId is empty — preview/scan will not work. Check that campaign={...} is passed.");
      }
      setPhase("preview");
      setPreview(null);
      setErrorMsg("");
      setCancelRequested(false);
      // NOTE: do NOT reset scanCancelRef here — that would un-cancel an
      // older scan loop still running in the background. Each new scan
      // creates its own local cancel object via startScan().
      setCampaignTag(""); // default: all tags
      setProgress({
        processed: { total: 0, hired: 0, promoted: 0, exited: 0, none: 0, stale: 0, unavailable: 0 },
        tasksCreated: 0,
        costUSD: 0,
        errors: [],
        batchesCompleted: 0,
      });
      fetchPreview("");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch preview (lead count + cost estimate)
  const fetchPreview = useCallback(async (tagOverride) => {
    if (!baseId) return;
    // Use the override if explicitly passed (avoids stale-closure issues from useEffect)
    const tagToSend = typeof tagOverride === "string" ? tagOverride : campaignTag;
    try {
      const res = await fetch("/api/scan-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          baseId,
          campaignId,
          freshnessSkipDays,
          campaignTag: tagToSend || null,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setErrorMsg(data.error || "Preview failed");
        setPhase("error");
        return;
      }
      setPreview(data);
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  }, [baseId, campaignId, freshnessSkipDays, campaignTag]);

  // Re-fetch preview when freshness OR campaignTag changes
  useEffect(() => {
    if (open && phase === "preview") fetchPreview();
  }, [freshnessSkipDays, campaignTag]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start chunked scan
  const startScan = useCallback(async () => {
    setPhase("scanning");
    setCancelRequested(false);

    // PER-SCAN local cancel: this scan's loop reads ONLY from this object.
    // If user closes + reopens modal mid-scan, the new scan creates its own
    // local cancel; the old loop continues to read from its captured
    // local cancel (which got set to true by safeClose), so it exits cleanly.
    const localCancel = { value: false };
    scanCancelRef.current = localCancel;

    let cursor = null;
    let batches = 0;
    const acc = {
      processed: { total: 0, hired: 0, promoted: 0, exited: 0, none: 0, stale: 0, unavailable: 0 },
      tasksCreated: 0,
      costUSD: 0,
      errors: [],
    };

    while (true) {
      // Read cancel signal from THIS scan's local cancel object
      if (localCancel.value) {
        setPhase("done");
        return;
      }
      try {
        const res = await fetch("/api/scan-leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scan",
            baseId,
            campaignId,
            movementWindowDays: windowDays,
            freshnessSkipDays,
            campaignTag: campaignTag || null,
            batchSize: 200,
            cursor,
            concurrency: 8,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          acc.errors.push(data.error || `HTTP ${res.status}`);
          setProgress({ ...acc, batchesCompleted: batches });
          setPhase("error");
          setErrorMsg(data.error || "Scan failed");
          return;
        }

        // Accumulate
        for (const k of Object.keys(acc.processed)) {
          acc.processed[k] += data.processed?.[k] || 0;
        }
        acc.tasksCreated += data.tasksCreated || 0;
        acc.costUSD += data.costUSD || 0;
        if (data.errors?.length) acc.errors.push(...data.errors);
        batches++;
        setProgress({ ...acc, batchesCompleted: batches });

        // Check cancel AGAIN before firing the next batch
        if (localCancel.value) {
          setPhase("done");
          return;
        }

        if (data.done || !data.nextCursor) {
          setPhase("done");
          return;
        }
        cursor = data.nextCursor;
      } catch (e) {
        acc.errors.push(e.message);
        setProgress({ ...acc, batchesCompleted: batches });
        setPhase("error");
        setErrorMsg(e.message);
        return;
      }
    }
  }, [baseId, campaignId, windowDays, freshnessSkipDays, campaignTag]);

  if (!open) return null;

  // Safe close: if a scan is running, also fire the cancel signal on the
  // live scan's local-cancel object so its loop halts.
  const safeClose = () => {
    if (phase === "scanning" && scanCancelRef.current) {
      scanCancelRef.current.value = true;
      setCancelRequested(true);
    }
    onClose();
  };

  return (
    <div style={modalBackdrop} onClick={safeClose}>
      <div style={modalBox} onClick={e => e.stopPropagation()}>
        <div style={modalHeader}>
          <h2 style={{ margin: 0, fontSize: 18 }}>🧭 Lead Movement Scan</h2>
          <button onClick={safeClose} style={closeBtn}>×</button>
        </div>

        {phase === "preview" && (
          <div>
            <p style={dim}>Scans all leads via RapidAPI (Fresh LinkedIn Profile Data) to detect job movement in the last N days. Creates tasks for Hired / Promoted / Exited.</p>

            {!baseId && (
              <div style={{ ...previewBox, background: "#3a2a1a", borderColor: "#642", color: "#fa6" }}>
                ⚠️ <strong>No campaign selected.</strong> Open a campaign first, then click Movement Scan from the Leads tab.
              </div>
            )}

            {baseId && tagOptions.length > 0 && (
              <div style={fieldRow}>
                <label style={lbl}>Campaign Tag filter:</label>
                <select
                  value={campaignTag}
                  onChange={e => setCampaignTag(e.target.value)}
                  style={{ ...inp, width: 220 }}
                >
                  <option value="">All leads ({leads.length})</option>
                  {tagOptions.map(t => (
                    <option key={t.name} value={t.name}>{t.name} ({t.count})</option>
                  ))}
                </select>
              </div>
            )}

            <div style={fieldRow}>
              <label style={lbl}>Movement window (days):</label>
              <input
                type="number"
                min={7}
                max={365}
                value={windowDays}
                onChange={e => setWindowDays(parseInt(e.target.value || "90", 10))}
                style={inp}
              />
            </div>

            <div style={fieldRow}>
              <label style={lbl}>Skip leads checked within (days):</label>
              <input
                type="number"
                min={0}
                max={30}
                value={freshnessSkipDays}
                onChange={e => setFreshnessSkipDays(parseInt(e.target.value || "0", 10))}
                style={inp}
              />
              <span style={hint}>Set to 0 to force full re-scan</span>
            </div>

            <div style={previewBox}>
              {preview ? (
                <>
                  <div><strong>Leads in base:</strong> {preview.totalLeadsInBase}</div>
                  {preview.campaignTag && (
                    <div><strong>In tag "{preview.campaignTag}":</strong> {preview.leadsInSelectedTag}</div>
                  )}
                  <div><strong>To scan:</strong> {preview.leadsToScan}</div>
                  <div><strong>Skipped (already fresh):</strong> {preview.leadsSkippedAsFresh}</div>
                  <div><strong>Cost per call:</strong> ${preview.perCallCostUSD.toFixed(4)}</div>
                  <div style={{ marginTop: 8, fontSize: 16 }}>
                    <strong>Estimated cost: ${preview.estimatedCostUSD.toFixed(2)}</strong>
                  </div>
                  <div style={{ ...hint, marginTop: 8 }}>
                    ~{Math.ceil(preview.leadsToScan / 200)} batch{Math.ceil(preview.leadsToScan / 200) === 1 ? "" : "es"} × ~100s each
                  </div>
                </>
              ) : (
                <div style={dim}>Loading preview…</div>
              )}
            </div>

            <div style={btnRow}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button
                onClick={startScan}
                disabled={!preview || preview.leadsToScan === 0}
                style={btnPrimary}
              >
                {preview && preview.leadsToScan === 0 ? "Nothing to scan" : "Start scan"}
              </button>
            </div>
          </div>
        )}

        {phase === "scanning" && (
          <div>
            <p style={{ margin: "4px 0 14px 0" }}>
              {cancelRequested
                ? <><span style={{ color: "#f80" }}>⏹ Stopping…</span> finishing current batch (up to ~100s).</>
                : <>Scanning… batch <strong>{progress.batchesCompleted + 1}</strong> in progress.</>
              }
            </p>
            <ProgressStats progress={progress} />
            <div style={{ ...hint, marginTop: 8 }}>
              {cancelRequested
                ? "Already-fired RapidAPI calls will complete; their cost is committed. No further batches will start."
                : "Tip: clicking Stop completes the current batch then halts. Cost so far is shown above."}
            </div>
            <div style={btnRow}>
              {!cancelRequested ? (
                <button
                  onClick={() => {
                    // Set the LIVE scan's local-cancel object (if any)
                    if (scanCancelRef.current) scanCancelRef.current.value = true;
                    setCancelRequested(true);
                  }}
                  style={btnDanger}
                >
                  ⏹ Stop scan
                </button>
              ) : (
                <button disabled style={{ ...btnDanger, opacity: 0.5, cursor: "default" }}>
                  ⏳ Stopping…
                </button>
              )}
            </div>
          </div>
        )}

        {phase === "done" && (
          <div>
            <p>
              {cancelRequested
                ? <>⏹ Scan stopped after {progress.batchesCompleted} batch{progress.batchesCompleted === 1 ? "" : "es"}.</>
                : <>✅ Scan complete — {progress.batchesCompleted} batch{progress.batchesCompleted === 1 ? "" : "es"}.</>
              }
            </p>
            <ProgressStats progress={progress} />
            {progress.errors.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ color: "#a55", cursor: "pointer" }}>
                  {progress.errors.length} error{progress.errors.length === 1 ? "" : "s"} (click to expand)
                </summary>
                <pre style={errBox}>{progress.errors.slice(0, 20).join("\n")}</pre>
              </details>
            )}
            <div style={btnRow}>
              <button onClick={onClose} style={btnPrimary}>Done</button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div>
            <p style={{ color: "#c44" }}>❌ Scan failed: {errorMsg}</p>
            <ProgressStats progress={progress} />
            <div style={btnRow}>
              <button onClick={onClose} style={btnPrimary}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressStats({ progress }) {
  const p = progress.processed;
  return (
    <div style={statsBox}>
      <div style={statsRow}>
        <Stat label="Total processed" value={p.total} />
        <Stat label="Tasks created" value={progress.tasksCreated} highlight />
      </div>
      <div style={statsRow}>
        <Stat label="🆕 Hired"     value={p.hired}     color="#3a8" />
        <Stat label="⬆ Promoted"  value={p.promoted}  color="#38a" />
        <Stat label="🚪 Exited"    value={p.exited}    color="#a83" />
      </div>
      <div style={statsRow}>
        <Stat label="None" value={p.none} muted />
        <Stat label="Stale" value={p.stale} muted />
        <Stat label="Unavailable" value={p.unavailable} muted />
      </div>
      <div style={{ marginTop: 8, fontSize: 13 }}>
        <strong>Cost so far:</strong> ${progress.costUSD.toFixed(4)}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight, muted, color }) {
  return (
    <div style={{ flex: 1, minWidth: 100 }}>
      <div style={{ fontSize: 11, color: muted ? "#888" : "#aaa", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{
        fontSize: highlight ? 22 : 18,
        fontWeight: 600,
        color: color || (muted ? "#999" : highlight ? "#dfa" : "#fff"),
      }}>{value}</div>
    </div>
  );
}

// ─── Inline styles (no Tailwind dependency, keeps modal self-contained) ─
const modalBackdrop = {
  position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
  background: "rgba(0,0,0,0.6)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 9999,
};
const modalBox = {
  background: "#1a1a1d", color: "#eee", borderRadius: 10,
  padding: 20, width: "92%", maxWidth: 540, maxHeight: "90vh", overflow: "auto",
  border: "1px solid #333",
};
const modalHeader = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  marginBottom: 12,
};
const closeBtn = {
  background: "none", border: "none", color: "#aaa", fontSize: 24, cursor: "pointer", padding: "0 6px",
};
const dim = { color: "#aaa", fontSize: 13, marginBottom: 12 };
const fieldRow = {
  display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap",
};
const lbl = { fontSize: 13, minWidth: 200 };
const inp = {
  background: "#222", color: "#eee", border: "1px solid #444",
  padding: "5px 8px", borderRadius: 4, width: 80, fontSize: 13,
};
const hint = { fontSize: 11, color: "#888" };
const previewBox = {
  background: "#222", border: "1px solid #333", borderRadius: 6,
  padding: 12, marginTop: 12, fontSize: 13, lineHeight: 1.6,
};
const btnRow = {
  display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16,
};
const btnPrimary = {
  background: "#c9a14a", color: "#000", border: "none",
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, cursor: "pointer", fontSize: 13,
};
const btnSecondary = {
  background: "#333", color: "#ccc", border: "1px solid #444",
  padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
};
const btnDanger = {
  background: "#c44", color: "#fff", border: "none",
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, cursor: "pointer", fontSize: 13,
};
const statsBox = {
  background: "#222", border: "1px solid #333", borderRadius: 6,
  padding: 12, marginTop: 12,
};
const statsRow = {
  display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap",
};
const errBox = {
  background: "#1a0a0a", border: "1px solid #422", borderRadius: 4,
  padding: 8, fontSize: 11, maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap",
};
