/**
 * talent-agent / tools / storage.ts
 * External tool: store_candidate — persists candidate data to SQLite.
 * Called by Kimi after scraping and scoring each candidate.
 */

import type { ExternalTool } from "@moonshot-ai/kimi-agent-sdk";
import { upsertCandidate } from "../core/memory.ts";
import { jsonSchema } from "../core/types.ts";
import { createHash } from "crypto";

export const storeCandidateTool: ExternalTool = {
  name: "store_candidate",
  description: `Persist a candidate profile (and optionally scoring/outreach data) to the local SQLite database.
Call this after scraping each LinkedIn profile. Call again with fitScore/scoring/outreach after scoring.
Returns the candidate ID for reference.`,
  parameters: jsonSchema(
    {
      linkedinUrl: { type: "string", description: "Full LinkedIn profile URL" },
      runId: { type: "string", description: "Current pipeline run ID" },
      name: { type: "string", description: "Candidate full name" },
      headline: { type: "string", description: "LinkedIn headline" },
      location: { type: "string", description: "Location from profile" },
      currentRole: { type: "string", description: "Current job title" },
      currentCompany: { type: "string", description: "Current employer" },
      summary: { type: "string", description: "LinkedIn About section (max 500 chars)" },
      skills: { type: "array", description: "Array of skill strings", items: { type: "string" } },
      experience: { type: "array", description: "Array of experience objects", items: { type: "object" } },
      fitScore: { type: "number", description: "0-100 fit score (omit if not yet scored)" },
      scoring: { type: "object", description: "Full scoring output with gate results (optional)" },
      outreach: { type: "object", description: "Outreach draft with linkedinMessage and emailBody (optional)" },
      contacts: { type: "object", description: "Contact details from the profile's Contact-info panel WHEN you are connected (e.g. { email, phone, websites, twitter }). Omit entirely if not connected or none shown — never fabricate." },
      outreachStatus: { type: "string", description: "Set ONLY after attempting to send outreach: 'sent' or 'failed'. Omit during discovery/scoring." },
    },
    ["linkedinUrl", "runId"]
  ),
  handler: async (params) => {
    const url = String(params["linkedinUrl"] ?? "").trim();
    const runId = String(params["runId"] ?? "").trim();
    if (!url || !runId) {
      return { output: "error: linkedinUrl and runId are required", message: "validation_failed" };
    }

    const id = createHash("sha256").update(url).digest("hex").slice(0, 16);

    try {
      upsertCandidate(id, url, params as Record<string, unknown>, runId);
      return {
        output: JSON.stringify({ id, linkedinUrl: url, status: "stored" }),
        message: `stored candidate ${id}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `error: ${msg}`, message: "storage_failed" };
    }
  },
};
