/**
 * talent-agent / tools / telegram.ts
 * External tool: notify_recruiter — delivers shortlist to Telegram.
 */

import type { ExternalTool } from "@moonshot-ai/kimi-agent-sdk";
import { jsonSchema } from "../core/types.ts";

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"] ?? "";
const TELEGRAM_LIMIT = 4000;

export const notifyRecruiterTool: ExternalTool = {
  name: "notify_recruiter",
  description: `Send the talent shortlist to the recruiter via Telegram.
Input: an array of candidate summaries, each with name, fitScore, currentRole, personalHook, linkedinUrl.
The tool formats them into a readable message and sends it. Long shortlists are split into multiple messages.`,
  parameters: jsonSchema(
    {
      jobSpec: { type: "string", description: "One-line job spec summary for the header" },
      runId: { type: "string", description: "Pipeline run ID for traceability" },
      candidates: {
        type: "array",
        description: "Array of top candidates (max 10)",
        items: { type: "object" },
      },
      totalDiscovered: { type: "number", description: "Total profiles discovered in this run" },
      totalScored: { type: "number", description: "Total profiles scored" },
      durationSeconds: { type: "number", description: "Pipeline duration in seconds" },
    },
    ["jobSpec", "runId", "candidates"]
  ),
  handler: async (params) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      return {
        output: "skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set",
        message: "telegram_not_configured",
      };
    }

    const candidates = (params["candidates"] as Record<string, unknown>[]) ?? [];
    const jobSpec = String(params["jobSpec"] ?? "");
    const runId = String(params["runId"] ?? "");
    const discovered = Number(params["totalDiscovered"] ?? 0);
    const scored = Number(params["totalScored"] ?? 0);
    const duration = Number(params["durationSeconds"] ?? 0);

    const messages = buildMessages(jobSpec, runId, candidates, discovered, scored, duration);

    const results: string[] = [];
    for (const msg of messages) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: msg,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
        });
        const json = await res.json() as { ok: boolean; result?: { message_id: number } };
        if (json.ok) {
          results.push(`message_id:${json.result?.message_id ?? "?"}`);
        } else {
          results.push(`send_failed`);
        }
        if (messages.length > 1) await Bun.sleep(500);
      } catch (err) {
        results.push(`error:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      output: JSON.stringify({ sent: results.length, messages: results }),
      message: `sent ${results.length} telegram message(s)`,
    };
  },
};

function buildMessages(
  jobSpec: string,
  runId: string,
  candidates: Record<string, unknown>[],
  discovered: number,
  scored: number,
  durationSeconds: number
): string[] {
  const header =
    `*Talent Shortlist - ${escapeMarkdown(jobSpec)}*\n` +
    `Run: \`${runId}\` - ${candidates.length} candidates\n` +
    `Discovered: ${discovered} - Scored: ${scored} - ${Math.round(durationSeconds)}s\n\n`;

  const parts: string[] = [];
  let current = header;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] as Record<string, unknown>;
    const name = String(c["name"] ?? "Unknown");
    const score = Number(c["fitScore"] ?? 0);
    const role = String(c["currentRole"] ?? "");
    const company = String(c["currentCompany"] ?? "");
    const hook = String(c["personalHook"] ?? "");
    const url = String(c["linkedinUrl"] ?? "");

    const bar = scoreBar(score);
    const entry =
      `*${i + 1}. ${escapeMarkdown(name)}* ${bar} ${score}%\n` +
      `${escapeMarkdown(role)} at ${escapeMarkdown(company)}\n` +
      (hook ? `_${escapeMarkdown(hook)}_\n` : "") +
      (url ? `[Profile](${url})\n` : "") +
      "\n";

    if (current.length + entry.length > TELEGRAM_LIMIT) {
      parts.push(current);
      current = entry;
    } else {
      current += entry;
    }
  }
  parts.push(current);
  return parts;
}

function scoreBar(score: number): string {
  if (score >= 90) return "🟢";
  if (score >= 75) return "🔵";
  if (score >= 60) return "🟡";
  return "🔴";
}

function escapeMarkdown(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
