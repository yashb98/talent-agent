/**
 * talent-agent / tools / notion.ts
 * External tool: save_to_notion — creates CRM entries in Notion.
 */

import type { ExternalTool } from "@moonshot-ai/kimi-agent-sdk";
import { Client } from "@notionhq/client";
import { jsonSchema } from "../core/types.ts";
import { setNotionPageId } from "../core/memory.ts";

const NOTION_KEY = process.env["NOTION_API_KEY"] ?? "";
const NOTION_DB_ID = process.env["NOTION_TALENT_DB_ID"] ?? "";

export const saveToNotionTool: ExternalTool = {
  name: "save_to_notion",
  description: `Create or update a candidate entry in the Notion Talent CRM database.
Call this for each top-10 candidate after scoring and drafting outreach.
Returns the Notion page ID.`,
  parameters: jsonSchema(
    {
      linkedinUrl: { type: "string", description: "LinkedIn profile URL" },
      name: { type: "string", description: "Candidate full name" },
      currentRole: { type: "string", description: "Current job title" },
      currentCompany: { type: "string", description: "Current employer" },
      location: { type: "string", description: "Location" },
      fitScore: { type: "number", description: "0-100 fit score" },
      jobSpec: { type: "string", description: "The job spec this candidate was found for" },
      runId: { type: "string", description: "Pipeline run ID" },
      linkedinMessage: { type: "string", description: "Draft LinkedIn outreach message (max 295 chars)" },
      emailBody: { type: "string", description: "Draft email body" },
      personalHook: { type: "string", description: "One-line personalization hook" },
      reasoning: { type: "string", description: "3-bullet scoring reasoning" },
    },
    ["linkedinUrl", "name", "fitScore", "runId"]
  ),
  handler: async (params) => {
    if (!NOTION_KEY || !NOTION_DB_ID) {
      return {
        output: JSON.stringify({ skipped: true, reason: "NOTION_API_KEY or NOTION_TALENT_DB_ID not set" }),
        message: "notion_not_configured",
      };
    }

    const notion = new Client({ auth: NOTION_KEY });

    try {
      const page = await notion.pages.create({
        parent: { database_id: NOTION_DB_ID },
        properties: {
          Name: { title: [{ text: { content: String(params["name"] ?? "Unknown") } }] },
          LinkedIn: { url: String(params["linkedinUrl"] ?? "") || null },
          FitScore: { number: Number(params["fitScore"] ?? 0) },
          JobSpec: { rich_text: [{ text: { content: String(params["jobSpec"] ?? "").slice(0, 2000) } }] },
          Status: { select: { name: "New" } },
          OutreachDraft: {
            rich_text: [{
              text: {
                content: String(params["linkedinMessage"] ?? "").slice(0, 2000),
              },
            }],
          },
          PersonalHook: {
            rich_text: [{ text: { content: String(params["personalHook"] ?? "").slice(0, 2000) } }],
          },
          RunId: { rich_text: [{ text: { content: String(params["runId"] ?? "") } }] },
          CurrentRole: { rich_text: [{ text: { content: String(params["currentRole"] ?? "").slice(0, 2000) } }] },
          Location: { rich_text: [{ text: { content: String(params["location"] ?? "").slice(0, 200) } }] },
        },
      });

      // Persist the page id back to the candidate row so future runs can
      // dedupe / update instead of creating duplicate Notion entries.
      const linkedinUrl = String(params["linkedinUrl"] ?? "").trim();
      if (linkedinUrl) {
        try { setNotionPageId(linkedinUrl, page.id); } catch { /* non-fatal */ }
      }

      return {
        output: JSON.stringify({ pageId: page.id, url: `https://notion.so/${page.id.replace(/-/g, "")}` }),
        message: `created notion page for ${String(params["name"] ?? "")}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `error: ${msg}`, message: "notion_failed" };
    }
  },
};
