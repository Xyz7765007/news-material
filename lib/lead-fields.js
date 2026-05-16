// ─── Lead-data field lookup ─────────────────────────────────────
// Different campaigns/Airtable bases use different field names for the same
// underlying data. Apollo exports use "Title", Sales Nav uses "Job Title",
// some manual sheets use "Position", "Designation", etc. Without a fallback
// chain, the scan reads "" and writes an empty Task — which is why Top X
// cards in the chatbot showed no LinkedIn URL, no phone, no title even
// though the Lead record DID have that data, just under a different name.
//
// Use pickLeadField(fields, kind) to robustly pull lead data regardless of
// which campaign convention is in use.
//
// Add new candidate names here when you find a new convention in the wild.

export const LEAD_FIELD_CANDIDATES = {
  title: [
    "Title", "Lead Title", "Job Title", "Position", "Designation",
    "Role", "Current Title", "Title - Cleaned",
  ],
  linkedinUrl: [
    "LinkedIn URL", "Linkedin URL", "LinkedIn Url", "Linkedin Url",
    "LinkedIn", "Linkedin", "LinkedIn Profile", "Profile URL",
    "LI URL", "LinkedinUrl", "linkedin_url", "Profile Link", "LinkedIn Link",
  ],
  email: [
    "Email", "Email Address", "Work Email", "Email - Cleaned",
    "Personal Email", "Business Email", "Primary Email",
  ],
  phone: [
    "Phone", "Phone Number", "Mobile", "Mobile Number", "Cell",
    "Cell Phone", "Phone Mobile", "Direct Phone", "Work Phone",
    "Mobile Phone", "Primary Phone",
  ],
};

export function pickLeadField(fields, kind) {
  const candidates = LEAD_FIELD_CANDIDATES[kind] || [];
  for (const name of candidates) {
    const v = fields[name];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}
