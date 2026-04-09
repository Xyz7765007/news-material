import { NextResponse } from "next/server";

const APOLLO_KEY = process.env.APOLLO_API_KEY;
const APOLLO_API = "https://api.apollo.io/api/v1";

// ─── Apollo: Enrich single person ────────────────────────────
async function enrichPerson(params) {
  const { name, email, company, linkedinUrl, domain } = params;

  // Try people/match first (most accurate)
  const matchBody = {};
  if (email) matchBody.email = email;
  if (name) {
    const parts = name.split(" ");
    matchBody.first_name = parts[0] || "";
    matchBody.last_name = parts.slice(1).join(" ") || "";
  }
  if (company) matchBody.organization_name = company;
  if (domain) matchBody.domain = domain;
  if (linkedinUrl) matchBody.linkedin_url = linkedinUrl;

  try {
    const res = await fetch(`${APOLLO_API}/people/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
      body: JSON.stringify(matchBody),
    });

    if (res.ok) {
      const data = await res.json();
      const person = data.person || {};
      if (person.id) {
        return {
          found: true,
          phone: person.phone_numbers?.[0]?.sanitized_number || person.phone_number?.sanitized_number || "",
          mobile: person.mobile_phone || "",
          directDial: person.organization?.primary_phone?.sanitized_number || "",
          email: person.email || email || "",
          title: person.title || "",
          company: person.organization?.name || company || "",
          linkedinUrl: person.linkedin_url || linkedinUrl || "",
          city: person.city || "",
          state: person.state || "",
          country: person.country || "",
        };
      }
    }
  } catch (e) {
    console.error("[APOLLO] Match error:", e.message);
  }

  // Fallback: search
  try {
    const searchBody = {
      person_titles: [],
      q_organization_name: company || "",
      page: 1, per_page: 1,
    };
    if (name) searchBody.q_keywords = name;

    const res = await fetch(`${APOLLO_API}/mixed_people/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
      body: JSON.stringify(searchBody),
    });

    if (res.ok) {
      const data = await res.json();
      const person = data.people?.[0];
      if (person) {
        return {
          found: true,
          phone: person.phone_numbers?.[0]?.sanitized_number || "",
          mobile: person.mobile_phone || "",
          directDial: "",
          email: person.email || email || "",
          title: person.title || "",
          company: person.organization?.name || company || "",
          linkedinUrl: person.linkedin_url || linkedinUrl || "",
          city: person.city || "",
          state: person.state || "",
          country: person.country || "",
        };
      }
    }
  } catch (e) {
    console.error("[APOLLO] Search error:", e.message);
  }

  return { found: false, phone: "", mobile: "", directDial: "" };
}

// ─── Batch enrich ────────────────────────────────────────────
async function batchEnrich(records) {
  const results = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    console.log(`[ENRICH] ${i + 1}/${records.length}: ${r.name || r.email || "unknown"}`);

    const enriched = await enrichPerson({
      name: r.name || "",
      email: r.email || "",
      company: r.company || "",
      linkedinUrl: r.linkedinUrl || "",
      domain: r.domain || "",
    });

    results.push({
      ...r,
      ...enriched,
      enrichedAt: new Date().toISOString(),
    });

    // Rate limit: Apollo allows ~5 req/sec
    if (i < records.length - 1) await new Promise(res => setTimeout(res, 250));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (!APOLLO_KEY) {
      return NextResponse.json({ error: "APOLLO_API_KEY not configured. Add it to your Vercel environment variables." }, { status: 500 });
    }

    switch (action) {
      case "test": {
        // Test Apollo connection
        try {
          const res = await fetch(`${APOLLO_API}/auth/health`, {
            headers: { "X-Api-Key": APOLLO_KEY },
          });
          if (res.ok) return NextResponse.json({ ok: true });
          return NextResponse.json({ ok: false, error: "Apollo API key invalid" });
        } catch (e) {
          return NextResponse.json({ ok: false, error: e.message });
        }
      }

      case "enrich": {
        const { records } = body;
        if (!records?.length) return NextResponse.json({ error: "No records to enrich" }, { status: 400 });

        const results = await batchEnrich(records);
        const found = results.filter(r => r.found).length;
        const withPhone = results.filter(r => r.phone || r.mobile).length;

        return NextResponse.json({
          results,
          stats: {
            total: records.length,
            found,
            withPhone,
            notFound: records.length - found,
          },
        });
      }

      case "enrich_single": {
        const result = await enrichPerson(body);
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("[ENRICH] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
