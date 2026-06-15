/**
 * talent-agent / core / types.ts
 * Framework-level types. Zero Vellum dependency.
 */

// ─── Agent Framework ────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Path to the kimi CLI binary */
  executable: string;
  /** Project working directory */
  workDir: string;
  /** Auto-approve tool calls (needed for Playwright MCP) */
  yolo: boolean;
  /** Enable Kimi K2.6 thinking mode */
  thinking: boolean;
  /** Path to AGENTS.md for project-level rules */
  agentFile?: string;
  /** Path to a project-local mcp.json (overrides ~/.kimi/mcp.json) */
  mcpConfig?: string;
}

export interface RunOptions {
  prompt: string;
  tools?: import("@moonshot-ai/kimi-agent-sdk").ExternalTool[];
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string }
  | { type: "step"; n: number }
  | { type: "status"; contextUsage?: number; tokens?: TokenUsage }
  | { type: "interrupted" }
  | { type: "subagent"; parentToolCallId: string; inner: AgentEvent | null }
  | { type: "todos"; items: TodoItem[] }
  | { type: "done"; summary: string; steps: number; tokens: TokenUsage };

export interface TodoItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}

export interface TokenUsage {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
  total: number;
}

// ─── Skill System ───────────────────────────────────────────────────────────

export interface SkillDef {
  /** Unique name, used as CLI command */
  name: string;
  description: string;
  /** External tools this skill registers */
  tools: import("@moonshot-ai/kimi-agent-sdk").ExternalTool[];
  /** Build the initial prompt from raw user input. Pass runId to control it
   *  (caller owns the id); omit to have the skill generate one. Optional `jd`
   *  is a full job description used as authoritative scoring criteria. */
  buildPrompt(input: string, runId?: string, jd?: string): string;
}

// ─── Memory / Cache ─────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  ttlHours: number;
}

export interface RunLog {
  runId: string;
  skill: string;
  prompt: string;
  startedAt: number;
  finishedAt?: number;
  steps: number;
  tokens: Partial<TokenUsage>;
  error?: string;
}

// ─── Tool helpers ────────────────────────────────────────────────────────────

/** What every custom tool handler must return */
export type ToolReturn = { output: string; message: string };

/** Helper to build a JSON Schema for external tool parameters */
export function jsonSchema(
  properties: Record<string, { type: string; description: string; items?: { type: string } }>,
  required?: string[]
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: required ?? Object.keys(properties),
  };
}
