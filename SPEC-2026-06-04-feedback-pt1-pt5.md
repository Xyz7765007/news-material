# Backend spec — Feedback batch pt1 + pt5 (Samarth review)

Date: 2026-06-04
Status: coded + build-verified locally (`✓ Compiled successfully`, Next 14.2.15). NOT pushed.
Owner/reviewer: Samarth (sole owner — no other people involved).

## pt1 — Simplify DM content to a 10-year-old reading level
File: `app/api/sidekick/auto-batch/generate/route.js`
Insert a PLAIN-LANGUAGE RULES block into the `system` prompt, immediately
before the "PER-MESSAGE REQUIREMENTS" section. Technical terms still allowed;
only sentence complexity is reduced. Personalization + internal-leak rules
untouched.

## pt5 — Product Marketing is not a relevant role
File: `lib/movement-detection.js`
Add `IRRELEVANT_ROLE_PATTERNS` + `isIrrelevantRole()`, and in
`buildTaskFromMovement` floor the score to 15 when the relevant title matches.
Movement scoring is hardcoded (Hired/Promoted 90, Exited 75) and has no role
awareness — this adds it. Feed sorts by Score desc so PM leads drop out.

No schema change, no new env var, no new dependency.

---

## Exact diff

```diff
diff --git a/app/api/sidekick/auto-batch/generate/route.js b/app/api/sidekick/auto-batch/generate/route.js
@@ Good (no public facts, leans on company + role): @@
 challenge. Curious how TraviYo is approaching that motion right now.
 Open to connecting?"
 
+═════════════════════════════════════════════════════════════
+PLAIN-LANGUAGE RULES (read at a 10-year-old's level):
+═════════════════════════════════════════════════════════════
+Write so a sharp 10-year-old could follow it. Assume they know the
+technical/industry terms (keep "ACV", "Qcom", "outbound", "D2C" etc.) —
+but keep the SENTENCES simple:
+  - Short sentences. One idea per sentence. Aim ≤ 15 words each.
+  - Plain everyday verbs: "saw", "build", "help", "set up" — not
+    "leverage", "facilitate", "utilize", "spearhead", "orchestrate".
+  - No stacked jargon or buzzword chains (✗ "best-in-class scalable
+    synergy"). Say the thing plainly.
+  - No long wind-up clauses. Get to the point in the first sentence.
+  - Prefer active voice ("we help D2C brands…") over passive
+    ("D2C brands are helped by…").
+  - If a sentence needs to be re-read to be understood, rewrite it.
+A simple message that a busy person grasps in 2 seconds beats a clever
+one. Specificity (the cited fact) stays; complexity goes.
+
 ═════════════════════════════════════════════════════════════
 PER-MESSAGE REQUIREMENTS:
 ═════════════════════════════════════════════════════════════

diff --git a/lib/movement-detection.js b/lib/movement-detection.js
@@ import { matchCompanyNames } from "./company-match"; @@
 import { daysSince } from "./linkedin-fetch";
 
+// ─── Irrelevant-role deprioritization ──────────────────────────────
+const IRRELEVANT_ROLE_PATTERNS = [
+  "product marketing",   // pt5: "Product Marketing is not a relevant role for us"
+];
+function isIrrelevantRole(title) {
+  const t = (title || "").toLowerCase();
+  if (!t) return false;
+  return IRRELEVANT_ROLE_PATTERNS.some(p => t.includes(p));
+}
+
 // Returns { type, reason, details, recommendedAction }

@@ buildTaskFromMovement scoring @@
-  const score = movementType === "Exited" ? 75 : 90;
+  let score = movementType === "Exited" ? 75 : 90;
+
+  const relevantTitle = movementType === "Exited"
+    ? (d.storedTitle || d.currentTitle)
+    : (d.currentTitle || d.storedTitle);
+  if (isIrrelevantRole(relevantTitle)) {
+    score = 15;
+    scoreReason = `${scoreReason} [Deprioritized: "${relevantTitle}" is not a relevant role for Veloka.]`;
+  }
```
