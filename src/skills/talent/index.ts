/**
 * talent-agent / skills / talent / index.ts
 * The Talent Intelligence Skill — assembles tools + prompt for a Kimi session.
 */

import { storeCandidateTool } from "../../tools/storage.ts";
import { notifyRecruiterTool } from "../../tools/telegram.ts";
import { saveToNotionTool } from "../../tools/notion.ts";
import { webbridgeTools } from "../../tools/webbridge.ts";
import { TALENT_SYSTEM_PROMPT, buildTalentPrompt } from "./prompts.ts";
import type { SkillDef } from "../../core/types.ts";
import type { ExternalTool } from "@moonshot-ai/kimi-agent-sdk";

/** All external tools for the talent skill */
export const talentTools: ExternalTool[] = [
  storeCandidateTool,
  notifyRecruiterTool,
  saveToNotionTool,
  ...webbridgeTools,
];

/** The talent skill definition */
export const talentSkill: SkillDef = {
  name: "talent",
  description: "Find and score LinkedIn candidates for a job specification",
  tools: talentTools,
  buildPrompt: (input: string, runId?: string, jd?: string) => {
    const id = runId ?? `ta-${Date.now()}`;
    const maxProfiles = Number(process.env["MAX_PROFILES"] ?? 30);
    return buildTalentPrompt(input, id, maxProfiles, jd);
  },
};
