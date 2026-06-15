#!/usr/bin/env bun
/**
 * talent-agent / src / index.ts
 * CLI entry point. Zero Vellum dependency.
 *
 * Usage:
 *   bun src/index.ts talent "Senior ML Engineer Python PyTorch London"
 *   bun src/index.ts talent "Senior ML Engineer Python PyTorch London" --thinking
 *   bun src/index.ts talent "Senior ML Engineer Python PyTorch London" --no-notion
 */

import { runAgentStreaming, defaultConfig, preflight } from "./core/agent.ts";
import { talentSkill } from "./skills/talent/index.ts";
import { startRun, finishRun, nextRunId } from "./core/memory.ts";
import type { AgentEvent, TokenUsage } from "./core/types.ts";

const SKILLS = new Map([["talent", talentSkill]]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const skillName = args[0];
  const input = args.slice(1).filter(a => !a.startsWith("--")).join(" ").trim();
  const useThinking = args.includes("--thinking");
  const noNotion = args.includes("--no-notion");
  const noTelegram = args.includes("--no-telegram");

  const skill = SKILLS.get(skillName);
  if (!skill) {
    console.error(`Unknown skill: ${skillName}. Available: ${[...SKILLS.keys()].join(", ")}`);
    process.exit(1);
  }
  if (!input) {
    console.error(`Please provide input for the ${skillName} skill.`);
    console.error(`Example: bun src/index.ts ${skillName} "Senior ML Engineer London"`);
    process.exit(1);
  }

  console.log(`\n\x1b[1m🎯 Talent Agent\x1b[0m`);
  console.log(`\x1b[2mSkill: ${skillName} | Input: ${input.slice(0, 80)}${input.length > 80 ? "..." : ""}\x1b[0m`);
  console.log(`\x1b[2mThinking: ${useThinking ? "ON" : "off"} | Notion: ${noNotion ? "skip" : "enabled"} | Telegram: ${noTelegram ? "skip" : "enabled"}\x1b[0m\n`);

  // Fail fast if Kimi CLI is missing or not authenticated — better here than mid-turn.
  try {
    preflight();
    console.log(`\x1b[2m✓ Kimi CLI authenticated\x1b[0m\n`);
  } catch (err) {
    console.error(`\n\x1b[31m✗ Preflight failed:\x1b[0m\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // Filter tools based on flags
  let tools = [...skill.tools];
  if (noNotion) tools = tools.filter(t => t.name !== "save_to_notion");
  if (noTelegram) tools = tools.filter(t => t.name !== "notify_recruiter");

  const config = defaultConfig({
    workDir: process.cwd(),
    thinking: useThinking,
    agentFile: `${process.cwd()}/agent.yaml`,
    mcpConfig: `${process.cwd()}/mcp.json`,
  });

  const runId = nextRunId(input);
  const prompt = skill.buildPrompt(input, runId);
  const startedAt = Date.now();

  startRun({ runId, skill: skillName, prompt: input, startedAt });

  const tokens: TokenUsage = { inputCacheHit: 0, inputCacheMiss: 0, output: 0, total: 0 };
  let steps = 0;

  try {
    await runAgentStreaming(config, {
      prompt,
      tools,
      onEvent: (event: AgentEvent) => {
        if (event.type === "step") steps = event.n;
        if (event.type === "status" && event.tokens) Object.assign(tokens, event.tokens);
      },
    });
    finishRun(runId, steps, tokens.total);
    console.log(`\n\x1b[32m✓ Run ${runId} complete\x1b[0m`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishRun(runId, steps, tokens.total, msg);
    console.error(`\n\x1b[31m✗ Run failed: ${msg}\x1b[0m`);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
\x1b[1mTalent Agent\x1b[0m — finds and ranks candidates for a job spec

\x1b[1mUsage:\x1b[0m
  bun src/index.ts <skill> <input> [options]

\x1b[1mSkills:\x1b[0m
  talent    Find LinkedIn candidates matching a job specification

\x1b[1mOptions:\x1b[0m
  --thinking     Enable Kimi K2.6 thinking mode (slower, deeper scoring)
  --no-notion    Skip Notion CRM entries
  --no-telegram  Skip Telegram notification
  --help, -h     Show this help

\x1b[1mExamples:\x1b[0m
  bun src/index.ts talent "Senior ML Engineer Python PyTorch London"
  bun src/index.ts talent "Staff SWE Distributed Systems remote UK" --thinking
  bun src/index.ts talent "Data Scientist fintech London" --no-telegram
`);
}

main().catch(console.error);
