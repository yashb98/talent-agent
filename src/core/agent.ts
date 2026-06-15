/**
 * talent-agent / core / agent.ts
 * Thin wrapper around @moonshot-ai/kimi-agent-sdk.
 * Handles session lifecycle, event streaming, and tool dispatch.
 */

import { createSession, isLoggedIn, type ExternalTool, type StreamEvent, type Session, type Turn } from "@moonshot-ai/kimi-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { AgentConfig, RunOptions, AgentEvent, TokenUsage, TodoItem } from "./types.ts";

const KIMI_EXECUTABLE =
  process.env["KIMI_EXECUTABLE"] ?? "/Users/yashbishnoi/.local/bin/kimi";

/**
 * Preflight check — verify the Kimi CLI is installed and the user is logged in.
 * Throws a descriptive error if anything is wrong, so we fail at startup
 * instead of hanging mid-turn when the SDK tries to call the API.
 */
export function preflight(executable: string = KIMI_EXECUTABLE): void {
  // 1. Binary exists
  if (!existsSync(executable)) {
    throw new Error(
      `Kimi CLI not found at ${executable}.\n` +
      `Install via: curl -fsSL https://moonshotai.github.io/kimi-cli/install.sh | bash\n` +
      `Or set KIMI_EXECUTABLE to the correct path.`
    );
  }
  // 2. Binary is executable
  try {
    const mode = statSync(executable).mode;
    if (!(mode & 0o111)) {
      throw new Error(`Kimi CLI at ${executable} is not executable. Run: chmod +x ${executable}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("not executable")) throw e;
  }
  // 3. Binary actually runs
  const version = spawnSync(executable, ["--version"], { timeout: 5000, encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(
      `Kimi CLI failed to run (exit ${version.status}).\n` +
      `stderr: ${version.stderr?.slice(0, 200) ?? "(none)"}`
    );
  }
  // 4. User is logged into the managed coding plan (OAuth)
  if (!isLoggedIn()) {
    throw new Error(
      `Not logged into Kimi.\n` +
      `Run: ${executable} login\n` +
      `This authenticates against the kimi-code OAuth coding plan ` +
      `(no MOONSHOT_API_KEY needed).`
    );
  }
}

export function defaultConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    executable: KIMI_EXECUTABLE,
    workDir: process.cwd(),
    yolo: true,         // auto-approve MCP tool calls (Playwright etc.)
    thinking: false,    // off by default — enable for deep scoring tasks
    ...overrides,
  };
}

// ─── RunHandle types ─────────────────────────────────────────────────────────

export interface RunHandle {
  sessionId: string;
  turn: Turn;
  completion: Promise<{ summary: string; steps: number; tokens: TokenUsage }>;
}

export interface CreateRunDeps {
  makeSession?: (opts: Parameters<typeof createSession>[0]) => Session;
}

// ─── createRun ───────────────────────────────────────────────────────────────

export function createRun(
  config: AgentConfig,
  options: RunOptions,
  deps: CreateRunDeps = {}
): RunHandle {
  const make = deps.makeSession ?? createSession;
  const session = make({
    workDir: config.workDir,
    executable: config.executable,
    yoloMode: config.yolo,
    thinking: config.thinking,
    agentFile: config.agentFile,
    ...(config.mcpConfig ? { mcpConfig: config.mcpConfig } : {}),
    externalTools: options.tools ?? [],
    clientInfo: { name: "talent-agent", version: "1.0.0" },
  });

  const turn = session.prompt(options.prompt);

  const completion = (async () => {
    let steps = 0;
    let summary = "";
    const tokens: TokenUsage = { inputCacheHit: 0, inputCacheMiss: 0, output: 0, total: 0 };
    const assembler = createEventAssembler();
    const handle = (mapped: AgentEvent) => {
      options.onEvent?.(mapped);
      if (mapped.type === "step") steps = mapped.n;
      if (mapped.type === "status" && mapped.tokens) {
        Object.assign(tokens, mapped.tokens);
        tokens.total = tokens.inputCacheHit + tokens.inputCacheMiss + tokens.output;
      }
      if (mapped.type === "text") summary += mapped.delta;
    };
    try {
      for await (const event of turn) {
        for (const mapped of assembler.push(event)) handle(mapped);
      }
      for (const mapped of assembler.flush()) handle(mapped); // emit any trailing tool call
    } finally {
      await session.close();
    }
    return { summary: summary.trim(), steps, tokens };
  })();

  return { sessionId: session.sessionId, turn, completion };
}

// ─── runAgent (thin wrapper) ─────────────────────────────────────────────────

/**
 * Run a single agent turn and collect all events.
 * Returns the final summary text and token usage.
 */
export async function runAgent(
  config: AgentConfig,
  options: RunOptions
): Promise<{ summary: string; steps: number; tokens: TokenUsage }> {
  return createRun(config, options).completion;
}

/**
 * Stream agent events to stdout as they arrive.
 * Good for interactive use and demos.
 */
export async function runAgentStreaming(
  config: AgentConfig,
  options: RunOptions
): Promise<void> {
  const result = await runAgent(config, {
    ...options,
    onEvent: (event) => {
      switch (event.type) {
        case "text":
          process.stdout.write(event.delta);
          break;
        case "thinking":
          process.stdout.write(`\x1b[2m${event.delta}\x1b[0m`); // dim
          break;
        case "tool_call":
          console.log(`\n\x1b[36m[tool:${event.name}]\x1b[0m`, JSON.stringify(event.input).slice(0, 120));
          break;
        case "tool_result":
          console.log(`\x1b[32m[result:${event.name}]\x1b[0m`, event.output.slice(0, 120));
          break;
        case "step":
          process.stdout.write(`\n\x1b[33m[step ${event.n}]\x1b[0m `);
          break;
        case "status":
          if (event.contextUsage) {
            process.stdout.write(` \x1b[2m(ctx: ${Math.round(event.contextUsage * 100)}%)\x1b[0m`);
          }
          break;
        case "done":
          console.log(`\n\n\x1b[32m✓ Done\x1b[0m in ${event.steps} steps · ${event.tokens.total} tokens`);
          break;
      }
      options.onEvent?.(event);
    },
  });
}

// ─── Internal event mapping ──────────────────────────────────────────────────

export function mapEvent(raw: StreamEvent): AgentEvent | null {
  // Wire events use PascalCase `type`, not snake_case `event`.
  // StreamEvent = WireEvent | WireRequest | ParseError.
  const t = (raw as { type?: string }).type;
  const payload = (raw as { payload?: unknown }).payload as Record<string, unknown> | undefined;

  if (process.env["TALENT_DEBUG_EVENTS"]) {
    process.stderr.write(`[evt] ${t} ${payload ? JSON.stringify(payload).slice(0, 200) : "(no payload)"}\n`);
  }

  switch (t) {
    case "TurnBegin":
    case "TurnEnd":
    case "CompactionBegin":
    case "CompactionEnd":
      return null;

    case "StepInterrupted":
      return { type: "interrupted" };

    case "StepBegin":
      return { type: "step", n: Number((payload as { n?: number })?.n ?? 0) };

    case "StatusUpdate": {
      const p = payload as {
        context_usage?: number | null;
        token_usage?: {
          input_cache_read: number;
          input_cache_creation: number;
          output: number;
          input_other: number;
        } | null;
      };
      const tu = p?.token_usage;
      return {
        type: "status",
        contextUsage: p?.context_usage ?? undefined,
        tokens: tu
          ? {
              inputCacheHit: tu.input_cache_read,
              inputCacheMiss: tu.input_cache_creation + tu.input_other,
              output: tu.output,
              total: tu.input_cache_read + tu.input_cache_creation + tu.input_other + tu.output,
            }
          : undefined,
      };
    }

    case "ContentPart": {
      const p = payload as { type?: string; text?: string; think?: string };
      if (p?.type === "text" && p.text) return { type: "text", delta: p.text };
      if (p?.type === "think" && p.think) return { type: "thinking", delta: p.think };
      return null;
    }

    case "ToolCall": {
      const p = payload as { function?: { name?: string; arguments?: string | null } };
      const name = p?.function?.name;
      if (!name) return null;
      let input: Record<string, unknown> = {};
      const argStr = p.function?.arguments;
      if (argStr) {
        try { input = JSON.parse(argStr); } catch { input = { _raw: argStr }; }
      }
      return { type: "tool_call", name, input };
    }

    case "ToolResult": {
      // Wire shape (confirmed at runtime): the result is nested under
      // `return_value`; top-level carries `tool_call_id`. Fall back to top-level
      // for resilience to wire variations.
      type RvShape = {
        is_error?: boolean;
        output?: string | Array<{ type: string; text?: string }>;
        display?: Array<{ type?: string; items?: unknown }>;
      };
      const p = payload as RvShape & { id?: string; tool_call_id?: string; return_value?: RvShape };
      const rv: RvShape = p?.return_value ?? p;

      // The agent's todo plan is delivered as a `todo` display block on the
      // ToolResult (the SetTodoList ToolCall streams empty args, so the call
      // itself carries no items) — surface it as a todos event for the PLAN panel.
      if (Array.isArray(rv?.display)) {
        const todoBlock = rv.display.find(d => d?.type === "todo" && Array.isArray(d.items));
        if (todoBlock) return { type: "todos", items: todoBlock.items as TodoItem[] };
      }

      let output = "";
      const out = rv?.output;
      if (typeof out === "string") output = out;
      else if (Array.isArray(out)) {
        output = out.map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("");
      }
      const prefix = rv?.is_error ? "[error] " : "";
      return { type: "tool_result", name: p?.tool_call_id ?? p?.id ?? "tool", output: prefix + output };
    }

    case "SubagentEvent": {
      const p = payload as { parent_tool_call_id?: string; event?: unknown } | undefined;
      const inner = p?.event ? mapEvent(p.event as StreamEvent) : null;
      return { type: "subagent", parentToolCallId: String(p?.parent_tool_call_id ?? ""), inner };
    }

    case "HookTriggered":
    case "HookResolved":
    case "ApprovalResponse":
    case "ToolCallPart":
    case "SteerInput":
    case "ParseError":
      return null;

    default:
      return null;
  }
}

/**
 * Stateful stream assembler. Tool-call arguments don't arrive on the `ToolCall`
 * event — they stream as a run of `ToolCallPart` deltas. This buffers those parts
 * per call and emits a single `tool_call` AgentEvent with the FULL parsed input
 * once the next event arrives (or on flush at end of stream). All other events
 * pass straight through `mapEvent`. Create one per run/replay (it holds state).
 */
export function createEventAssembler(): {
  push: (raw: StreamEvent) => AgentEvent[];
  flush: () => AgentEvent[];
} {
  let pending: { name: string; args: string } | null = null;

  function flush(): AgentEvent[] {
    if (!pending) return [];
    let input: Record<string, unknown> = {};
    if (pending.args) {
      try { input = JSON.parse(pending.args); } catch { input = { _raw: pending.args }; }
    }
    const ev: AgentEvent = { type: "tool_call", name: pending.name, input };
    pending = null;
    return [ev];
  }

  function push(raw: StreamEvent): AgentEvent[] {
    const t = (raw as { type?: string }).type;
    const payload = (raw as { payload?: unknown }).payload as Record<string, unknown> | undefined;

    if (t === "ToolCall") {
      const prev = flush(); // close out the previous call before starting a new one
      const fn = payload?.["function"] as { name?: string; arguments?: unknown } | undefined;
      const name = fn?.name;
      const args = typeof fn?.arguments === "string" ? fn.arguments : "";
      pending = name ? { name, args } : null;
      return prev;
    }
    if (t === "ToolCallPart") {
      const part = payload?.["arguments_part"];
      if (pending && typeof part === "string") pending.args += part;
      return [];
    }

    const prev = flush();
    const mapped = mapEvent(raw);
    return mapped ? [...prev, mapped] : prev;
  }

  return { push, flush };
}

/** If an AgentEvent is the agent's SetTodoList tool call, return its todo items. */
export function detectTodos(ev: AgentEvent): TodoItem[] | null {
  if (ev.type !== "tool_call" || ev.name !== "SetTodoList") return null;
  const items = (ev.input as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  return items
    .filter((i): i is { title: string; status: string } =>
      !!i && typeof (i as any).title === "string" && typeof (i as any).status === "string")
    .map(i => ({
      title: i.title,
      status: (["pending", "in_progress", "done"].includes(i.status) ? i.status : "pending") as TodoItem["status"],
    }));
}
