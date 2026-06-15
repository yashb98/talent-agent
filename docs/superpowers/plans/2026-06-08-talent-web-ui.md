# Talent Agent Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the talent-agent into a local web app that launches runs, streams them live (steps/tokens/tools/candidates/sub-agents/todos), supports interrupt+steer+replay, and browses results from `data/talent.db`.

**Architecture:** One `Bun.serve()` process serves the dossier UI + a JSON API over SQLite + a WebSocket. Launching calls the existing Kimi harness (`createRun` in `core/agent.ts`) in-process; each structured `AgentEvent` is broadcast to WS clients. Kimi external-tool handlers run in-process and write to the same DB the API reads, so candidates stream with no extra plumbing. One run at a time (shared WebBridge Chrome + run lock).

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `@moonshot-ai/kimi-agent-sdk` v0.1.8 (drives the local `kimi` CLI over stdio JSON-RPC, OAuth auth), `Bun.serve` WebSocket, vanilla HTML/CSS/JS frontend.

**Spec:** `docs/superpowers/specs/2026-06-08-talent-web-ui-design.md`

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/memory.ts` | + `listRuns()`, `getRunCandidates()`, `kimi_session_id` column + `setKimiSessionId()` | 1 |
| `src/core/types.ts` | Extend `AgentEvent` union: `interrupted`, `subagent`, `todos` | 2 |
| `src/core/agent.ts` | Extend `mapEvent` (SubagentEvent / StepInterrupted / SetTodoList); add `createRun()`; make `runAgent` a wrapper | 2, 3 |
| `src/web/api.ts` | Pure DB→view helpers: `normalizeCandidate()`, `listRunsView()`, `getRunView()` | 4 |
| `src/web/runManager.ts` | Run lock + active-run handle; `launch()`, `interrupt()`, `steer()` | 5 |
| `src/server.ts` | `Bun.serve`: static + JSON API + WebSocket; wires `onEvent`→broadcast | 6 |
| `web/dashboard.html` | Rewire to API + WS; launch bar, live console, PLAN panel, sub-agent tree, run picker, replay | 7 |
| `package.json` | `"web"` script | 8 |

Tests: `src/core/memory.test.ts` (extend), `src/core/agent.test.ts` (new), `src/web/api.test.ts` (new), `src/web/runManager.test.ts` (new).

All tests use an isolated temp DB by setting `TALENT_DB_PATH` before importing `memory.ts` (pattern already in `src/core/memory.test.ts`).

---

## Task 1: Memory — run list, run candidates, Kimi session id

**Files:**
- Modify: `src/core/memory.ts`
- Test: `src/core/memory.test.ts` (extend existing)

- [ ] **Step 1: Write failing tests**

Append to `src/core/memory.test.ts`:

```ts
test("listRuns returns runs newest-first with candidate counts", () => {
  mem.startRun({ runId: "r-100", skill: "talent", prompt: "spec A", startedAt: 100 });
  mem.startRun({ runId: "r-200", skill: "talent", prompt: "spec B", startedAt: 200 });
  mem.finishRun("r-100", 5, 1234);
  mem.upsertCandidate("c1", "https://linkedin.com/in/a", { name: "A", fitScore: 80 }, "r-100");
  mem.upsertCandidate("c2", "https://linkedin.com/in/b", { name: "B", fitScore: 70 }, "r-100");

  const runs = mem.listRuns();
  expect(runs[0].runId).toBe("r-200");           // newest first by started_at
  const r100 = runs.find(r => r.runId === "r-100")!;
  expect(r100.candidateCount).toBe(2);
  expect(r100.steps).toBe(5);
  expect(r100.tokensTotal).toBe(1234);
});

test("getRunCandidates returns rich rows for a run, score-desc", () => {
  mem.startRun({ runId: "r-300", skill: "talent", prompt: "spec", startedAt: 300 });
  mem.upsertCandidate("d1", "https://linkedin.com/in/lo", { name: "Lo", fitScore: 60 }, "r-300");
  mem.upsertCandidate("d2", "https://linkedin.com/in/hi", { name: "Hi", fitScore: 95 }, "r-300");
  const rows = mem.getRunCandidates("r-300");
  expect(rows.map(r => r.name)).toEqual(["Hi", "Lo"]);
  expect(rows[0].linkedin_url).toBe("https://linkedin.com/in/hi");
});

test("kimi_session_id round-trips", () => {
  mem.startRun({ runId: "r-400", skill: "talent", prompt: "spec", startedAt: 400 });
  mem.setKimiSessionId("r-400", "kimi-sess-xyz");
  const run = mem.listRuns().find(r => r.runId === "r-400")!;
  expect(run.kimiSessionId).toBe("kimi-sess-xyz");
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/core/memory.test.ts`
Expected: FAIL — `mem.listRuns is not a function` (and `getRunCandidates`, `setKimiSessionId`).

- [ ] **Step 3: Add the schema column**

In `src/core/memory.ts`, inside `initSchema`, add the column to the `run_log` table definition (after `error TEXT`):

```ts
      error TEXT,
      kimi_session_id TEXT
```

Then, immediately after the `db.exec(\`...\`)` block in `initSchema`, add an idempotent migration for pre-existing DBs:

```ts
  // Migration: add kimi_session_id to run_log if an older DB predates it.
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(run_log)`).all();
  if (!cols.some(c => c.name === "kimi_session_id")) {
    db.exec(`ALTER TABLE run_log ADD COLUMN kimi_session_id TEXT`);
  }
```

- [ ] **Step 4: Add the query functions**

Add to `src/core/memory.ts` (after `finishRun`):

```ts
export interface RunSummary {
  runId: string;
  skill: string;
  prompt: string;
  startedAt: number;
  finishedAt: number | null;
  steps: number;
  tokensTotal: number;
  error: string | null;
  kimiSessionId: string | null;
  candidateCount: number;
}

export function listRuns(): RunSummary[] {
  const rows = getDb().query<{
    run_id: string; skill: string; prompt: string; started_at: number;
    finished_at: number | null; steps: number; tokens_total: number;
    error: string | null; kimi_session_id: string | null; candidate_count: number;
  }, []>(`
    SELECT r.run_id, r.skill, r.prompt, r.started_at, r.finished_at, r.steps,
           r.tokens_total, r.error, r.kimi_session_id,
           (SELECT COUNT(*) FROM candidates c WHERE c.run_id = r.run_id) AS candidate_count
    FROM run_log r
    ORDER BY r.started_at DESC
  `).all();
  return rows.map(r => ({
    runId: r.run_id, skill: r.skill, prompt: r.prompt, startedAt: r.started_at,
    finishedAt: r.finished_at, steps: r.steps, tokensTotal: r.tokens_total,
    error: r.error, kimiSessionId: r.kimi_session_id, candidateCount: r.candidate_count,
  }));
}

export interface CandidateFull {
  id: string; linkedin_url: string; name: string | null; headline: string | null;
  location: string | null; current_role: string | null; current_company: string | null;
  skills: string | null; experience: string | null; summary: string | null;
  fit_score: number | null; scoring_json: string | null; outreach_json: string | null;
  notion_page_id: string | null; run_id: string | null;
}

export function getRunCandidates(runId: string): CandidateFull[] {
  return getDb().query<CandidateFull, [string]>(
    `SELECT id, linkedin_url, name, headline, location, current_role, current_company,
            skills, experience, summary, fit_score, scoring_json, outreach_json,
            notion_page_id, run_id
     FROM candidates WHERE run_id = ? ORDER BY fit_score DESC NULLS LAST`
  ).all(runId);
}

export function setKimiSessionId(runId: string, sessionId: string): void {
  getDb().run(`UPDATE run_log SET kimi_session_id = ? WHERE run_id = ?`, [sessionId, runId]);
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `bun test src/core/memory.test.ts`
Expected: PASS (all, including the 2 pre-existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/memory.ts src/core/memory.test.ts
git commit -m "feat(memory): listRuns, getRunCandidates, kimi_session_id"
```

---

## Task 2: Event model — extend AgentEvent and mapEvent

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/agent.ts` (the `mapEvent` function + a `detectTodos` helper)
- Test: `src/core/agent.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `src/core/agent.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mapEvent, detectTodos } from "./agent.ts";

test("StepInterrupted maps to interrupted", () => {
  expect(mapEvent({ type: "StepInterrupted", payload: {} } as any))
    .toEqual({ type: "interrupted" });
});

test("SubagentEvent maps inner event and tags parent", () => {
  const raw = {
    type: "SubagentEvent",
    payload: {
      parent_tool_call_id: "tc-7",
      event: { type: "StepBegin", payload: { n: 3 } },
    },
  };
  expect(mapEvent(raw as any)).toEqual({
    type: "subagent",
    parentToolCallId: "tc-7",
    inner: { type: "step", n: 3 },
  });
});

test("detectTodos reads SetTodoList tool-call args", () => {
  const ev = {
    type: "tool_call" as const,
    name: "SetTodoList",
    input: { items: [{ title: "discover", status: "done" }, { title: "scrape", status: "in_progress" }] },
  };
  expect(detectTodos(ev)).toEqual([
    { title: "discover", status: "done" },
    { title: "scrape", status: "in_progress" },
  ]);
});

test("detectTodos returns null for non-todo tool calls", () => {
  expect(detectTodos({ type: "tool_call", name: "store_candidate", input: {} })).toBeNull();
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/core/agent.test.ts`
Expected: FAIL — `mapEvent`/`detectTodos` not exported, or `interrupted`/`subagent` not produced.

- [ ] **Step 3: Extend the AgentEvent union**

In `src/core/types.ts`, replace the `AgentEvent` union with:

```ts
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
```

- [ ] **Step 4: Export mapEvent + add the new mappings + detectTodos**

In `src/core/agent.ts`:

1. Change `function mapEvent(` to `export function mapEvent(`.
2. Add `import type { ... TodoItem } from "./types.ts";` (extend the existing type import to include `TodoItem`).
3. Replace the `case "StepInterrupted": return null;` handling. Currently `StepInterrupted` is grouped with the early `return null` block — remove it from that block and add a dedicated case:

```ts
    case "StepInterrupted":
      return { type: "interrupted" };
```

4. Replace the `case "SubagentEvent": ... return null;` (currently in the trailing null group) with:

```ts
    case "SubagentEvent": {
      const p = payload as { parent_tool_call_id?: string; event?: unknown } | undefined;
      const inner = p?.event ? mapEvent(p.event as StreamEvent) : null;
      return { type: "subagent", parentToolCallId: String(p?.parent_tool_call_id ?? ""), inner };
    }
```

5. Add the `detectTodos` helper at the end of the file:

```ts
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
```

Add `AgentEvent` and `TodoItem` to the type import at the top of `agent.ts` if not already present.

- [ ] **Step 5: Run tests, verify they pass**

Run: `bun test src/core/agent.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/agent.ts src/core/agent.test.ts
git commit -m "feat(agent): map subagent/interrupted events, detect todos"
```

---

## Task 3: createRun — expose the live Turn + sessionId

**Files:**
- Modify: `src/core/agent.ts`
- Test: `src/core/agent.test.ts` (extend)

**Design note:** `createRun` takes an optional `makeSession` factory (defaults to the SDK's `createSession`) so it can be unit-tested with a fake session/turn. `runAgent` becomes a thin wrapper that awaits `completion`.

- [ ] **Step 1: Write failing tests**

Append to `src/core/agent.test.ts`:

```ts
import { createRun, defaultConfig } from "./agent.ts";

function fakeSession(events: any[]) {
  const calls: { interrupt: number; steer: string[] } = { interrupt: 0, steer: [] };
  const turn = {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
    interrupt: async () => { calls.interrupt++; },
    steer: async (m: string) => { calls.steer.push(m); },
  };
  let closed = false;
  const session = {
    sessionId: "sess-fake",
    prompt: () => turn,
    close: async () => { closed = true; },
  };
  return { session, turn, calls, wasClosed: () => closed };
}

test("createRun streams mapped events, returns sessionId, closes session", async () => {
  const fk = fakeSession([
    { type: "StepBegin", payload: { n: 1 } },
    { type: "ContentPart", payload: { type: "text", text: "hi" } },
  ]);
  const seen: any[] = [];
  const handle = createRun(
    defaultConfig({ workDir: "/tmp" }),
    { prompt: "go", tools: [], onEvent: e => seen.push(e) },
    { makeSession: () => fk.session as any }
  );
  expect(handle.sessionId).toBe("sess-fake");
  const res = await handle.completion;
  expect(seen).toContainEqual({ type: "step", n: 1 });
  expect(seen).toContainEqual({ type: "text", delta: "hi" });
  expect(res.summary).toBe("hi");
  expect(fk.wasClosed()).toBe(true);
});

test("createRun handle exposes interrupt/steer on the turn", async () => {
  const fk = fakeSession([]);
  const handle = createRun(
    defaultConfig({ workDir: "/tmp" }),
    { prompt: "go", tools: [], onEvent: () => {} },
    { makeSession: () => fk.session as any }
  );
  await handle.turn.interrupt();
  await handle.turn.steer("focus London");
  await handle.completion;
  expect(fk.calls.interrupt).toBe(1);
  expect(fk.calls.steer).toEqual(["focus London"]);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/core/agent.test.ts`
Expected: FAIL — `createRun is not exported`.

- [ ] **Step 3: Implement createRun and refactor runAgent**

In `src/core/agent.ts`, add the imports/types and the function. Add near the top:

```ts
import { createSession, isLoggedIn, type ExternalTool, type StreamEvent, type Session, type Turn } from "@moonshot-ai/kimi-agent-sdk";

export interface RunHandle {
  sessionId: string;
  turn: Turn;
  completion: Promise<{ summary: string; steps: number; tokens: TokenUsage }>;
}

export interface CreateRunDeps {
  makeSession?: (opts: Parameters<typeof createSession>[0]) => Session;
}
```

Add the function:

```ts
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
    try {
      for await (const event of turn) {
        const mapped = mapEvent(event);
        if (!mapped) continue;
        options.onEvent?.(mapped);
        if (mapped.type === "step") steps = mapped.n;
        if (mapped.type === "status" && mapped.tokens) {
          Object.assign(tokens, mapped.tokens);
          tokens.total = tokens.inputCacheHit + tokens.inputCacheMiss + tokens.output;
        }
        if (mapped.type === "text") summary += mapped.delta;
      }
    } finally {
      await session.close();
    }
    return { summary: summary.trim(), steps, tokens };
  })();

  return { sessionId: session.sessionId, turn, completion };
}
```

Then replace the body of the existing `runAgent` so it delegates:

```ts
export async function runAgent(
  config: AgentConfig,
  options: RunOptions
): Promise<{ summary: string; steps: number; tokens: TokenUsage }> {
  return createRun(config, options).completion;
}
```

(Delete the old inline session/loop code inside `runAgent`; `runAgentStreaming` is unchanged because it calls `runAgent`.)

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/core/agent.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Verify the CLI still type-checks and runs help**

Run: `bunx tsc --noEmit && bun src/index.ts --help`
Expected: tsc exits 0; help text prints.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent.ts src/core/agent.test.ts
git commit -m "feat(agent): createRun exposes turn+sessionId; runAgent delegates"
```

---

## Task 4: Web API helpers (pure DB→view)

**Files:**
- Create: `src/web/api.ts`
- Test: `src/web/api.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/web/api.test.ts`:

```ts
import { test, expect, beforeAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["TALENT_DB_PATH"] = join(tmpdir(), `talent-api-test-${process.pid}.db`);

let api: typeof import("./api.ts");
let mem: typeof import("../core/memory.ts");

beforeAll(async () => {
  api = await import("./api.ts");
  mem = await import("../core/memory.ts");
});

test("normalizeCandidate maps a full row", () => {
  const row = {
    id: "x", linkedin_url: "https://linkedin.com/in/x", name: "Ada", headline: "ML",
    location: "London", current_role: "Engineer", current_company: "Acme",
    skills: '["python"]', experience: "[]", summary: "s", fit_score: 91,
    scoring_json: JSON.stringify({ Skills: 95, Seniority: 88, Location: 100, Recency: 70, Standout: 80 }),
    outreach_json: JSON.stringify({ linkedinMessage: "hi", emailBody: "body", personalHook: "hook" }),
    notion_page_id: null, run_id: "r1",
  };
  const c = api.normalizeCandidate(row as any);
  expect(c).toMatchObject({
    name: "Ada", score: 91, role: "Engineer", company: "Acme", loc: "London",
    url: "https://linkedin.com/in/x", hook: "hook", li: "hi", email: "body",
  });
  expect(c.gates).toEqual({ Skills: 95, Seniority: 88, Location: 100, Recency: 70, Standout: 80 });
});

test("normalizeCandidate degrades for a scrape-only row", () => {
  const row = {
    id: "y", linkedin_url: "https://linkedin.com/in/y", name: "Bo", headline: null,
    location: null, current_role: null, current_company: null, skills: null,
    experience: null, summary: null, fit_score: null, scoring_json: null,
    outreach_json: null, notion_page_id: null, run_id: "r1",
  };
  const c = api.normalizeCandidate(row as any);
  expect(c.score).toBeNull();
  expect(c.gates).toBeNull();
  expect(c.li).toBeNull();
  expect(c.name).toBe("Bo");
});

test("normalizeCandidate never throws on malformed JSON", () => {
  const row = {
    id: "z", linkedin_url: "https://linkedin.com/in/z", name: "Cy", headline: null,
    location: null, current_role: null, current_company: null, skills: null,
    experience: null, summary: null, fit_score: 50,
    scoring_json: "{not json", outreach_json: "also broken",
    notion_page_id: null, run_id: "r1",
  };
  const c = api.normalizeCandidate(row as any);
  expect(c.gates).toBeNull();
  expect(c.li).toBeNull();
  expect(c.score).toBe(50);
});

test("getRunView returns run meta + normalized candidates", () => {
  mem.startRun({ runId: "rv-1", skill: "talent", prompt: "spec", startedAt: 1 });
  mem.upsertCandidate("k1", "https://linkedin.com/in/k", { name: "K", fitScore: 77 }, "rv-1");
  const view = api.getRunView("rv-1");
  expect(view).not.toBeNull();
  expect(view!.run.runId).toBe("rv-1");
  expect(view!.candidates[0].name).toBe("K");
});

test("getRunView returns null for unknown run", () => {
  expect(api.getRunView("nope")).toBeNull();
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/web/api.test.ts`
Expected: FAIL — cannot find module `./api.ts`.

- [ ] **Step 3: Implement `src/web/api.ts`**

```ts
/**
 * talent-agent / web / api.ts
 * Pure DB→view helpers. No HTTP, no I/O beyond the memory module — unit-testable.
 */

import { listRuns, getRunCandidates, type RunSummary, type CandidateFull } from "../core/memory.ts";

export interface CandidateView {
  id: string;
  name: string;
  score: number | null;
  role: string;
  company: string;
  loc: string;
  url: string;
  hook: string;
  li: string | null;
  email: string | null;
  gates: Record<string, number> | null;
  notion: boolean;
}

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

export function normalizeCandidate(row: CandidateFull): CandidateView {
  const scoring = safeParse<Record<string, unknown>>(row.scoring_json);
  const outreach = safeParse<Record<string, unknown>>(row.outreach_json);

  // Gates: accept either {Skills,Seniority,...} at top level or under scoring.gates.
  const gateSource = (scoring?.["gates"] as Record<string, unknown>) ?? scoring ?? null;
  let gates: Record<string, number> | null = null;
  if (gateSource) {
    const keys = ["Skills", "Seniority", "Location", "Recency", "Standout"];
    const picked: Record<string, number> = {};
    for (const k of keys) {
      const v = gateSource[k];
      if (typeof v === "number") picked[k] = v;
    }
    if (Object.keys(picked).length > 0) gates = picked;
  }

  return {
    id: row.id,
    name: row.name ?? "Unknown",
    score: typeof row.fit_score === "number" ? row.fit_score : null,
    role: row.current_role ?? "",
    company: row.current_company ?? "",
    loc: row.location ?? "",
    url: row.linkedin_url,
    hook: (outreach?.["personalHook"] as string) ?? "",
    li: (outreach?.["linkedinMessage"] as string) ?? null,
    email: (outreach?.["emailBody"] as string) ?? null,
    gates,
    notion: !!row.notion_page_id,
  };
}

export function listRunsView(): RunSummary[] {
  return listRuns();
}

export function getRunView(runId: string): { run: RunSummary; candidates: CandidateView[] } | null {
  const run = listRuns().find(r => r.runId === runId);
  if (!run) return null;
  const candidates = getRunCandidates(runId).map(normalizeCandidate);
  return { run, candidates };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/web/api.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/api.test.ts
git commit -m "feat(web): pure DB->view API helpers"
```

---

## Task 5: Run manager — lock + active handle + interrupt/steer

**Files:**
- Create: `src/web/runManager.ts`
- Test: `src/web/runManager.test.ts`

**Design note:** the manager owns a single `active` run. `launch()` throws `RunActiveError` if one is running; `interrupt()`/`steer()` throw `NotActiveError` if `:id` is not the active run. It depends on an injected `createRun` so tests need no live CLI.

- [ ] **Step 1: Write failing tests**

Create `src/web/runManager.test.ts`:

```ts
import { test, expect, beforeAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["TALENT_DB_PATH"] = join(tmpdir(), `talent-rm-test-${process.pid}.db`);

let rm: typeof import("./runManager.ts");

beforeAll(async () => { rm = await import("./runManager.ts"); });

function fakeHandle() {
  let resolve!: () => void;
  const completion = new Promise<{ summary: string; steps: number; tokens: any }>(r => {
    resolve = () => r({ summary: "", steps: 1, tokens: { total: 0 } });
  });
  const calls = { interrupt: 0, steer: [] as string[] };
  return {
    handle: {
      sessionId: "s1",
      turn: { interrupt: async () => { calls.interrupt++; }, steer: async (m: string) => { calls.steer.push(m); } },
      completion,
    },
    calls,
    finish: resolve,
  };
}

test("second launch while active throws RunActiveError", async () => {
  const mgr = rm.createRunManager({
    createRun: () => fakeHandle().handle as any,
    broadcast: () => {},
    buildConfigAndPrompt: () => ({ config: {} as any, prompt: "p", tools: [], runId: "ra-1" }),
  });
  mgr.launch({ spec: "x", thinking: false, notion: false, telegram: false });
  expect(() => mgr.launch({ spec: "y", thinking: false, notion: false, telegram: false }))
    .toThrow(rm.RunActiveError);
});

test("interrupt forwards to the active turn; wrong id throws", async () => {
  const fk = fakeHandle();
  const mgr = rm.createRunManager({
    createRun: () => fk.handle as any,
    broadcast: () => {},
    buildConfigAndPrompt: () => ({ config: {} as any, prompt: "p", tools: [], runId: "ra-2" }),
  });
  const { runId } = mgr.launch({ spec: "x", thinking: false, notion: false, telegram: false });
  await expect(mgr.interrupt("wrong-id")).rejects.toThrow(rm.NotActiveError);
  await mgr.interrupt(runId);
  expect(fk.calls.interrupt).toBe(1);
  await mgr.steer(runId, "focus");
  expect(fk.calls.steer).toEqual(["focus"]);
});

test("active clears after completion, allowing a new launch", async () => {
  const fk = fakeHandle();
  const mgr = rm.createRunManager({
    createRun: () => fk.handle as any,
    broadcast: () => {},
    buildConfigAndPrompt: () => ({ config: {} as any, prompt: "p", tools: [], runId: "ra-3" }),
  });
  mgr.launch({ spec: "x", thinking: false, notion: false, telegram: false });
  fk.finish();
  await fk.handle.completion;
  await Promise.resolve();
  expect(mgr.activeRunId()).toBeNull();
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/web/runManager.test.ts`
Expected: FAIL — cannot find module `./runManager.ts`.

- [ ] **Step 3: Implement `src/web/runManager.ts`**

```ts
/**
 * talent-agent / web / runManager.ts
 * Owns the single active run: lock, handle, interrupt/steer, lifecycle broadcast.
 * Dependencies are injected so this is unit-testable without the Kimi CLI.
 */

import type { AgentEvent } from "../core/types.ts";
import type { RunHandle } from "../core/agent.ts";
import { startRun, finishRun, setKimiSessionId } from "../core/memory.ts";
import { detectTodos } from "../core/agent.ts";

export class RunActiveError extends Error {}
export class NotActiveError extends Error {}

export interface LaunchParams {
  spec: string;
  thinking: boolean;
  notion: boolean;
  telegram: boolean;
}

export interface RunManagerDeps {
  /** Build the kimi config + prompt + filtered tools + runId for a launch. */
  buildConfigAndPrompt: (p: LaunchParams) => {
    config: import("../core/types.ts").AgentConfig;
    prompt: string;
    tools: import("@moonshot-ai/kimi-agent-sdk").ExternalTool[];
    runId: string;
  };
  /** Start the run; injected so tests can supply a fake. Defaults to core createRun. */
  createRun: (
    config: import("../core/types.ts").AgentConfig,
    options: { prompt: string; tools: any[]; onEvent: (e: AgentEvent) => void }
  ) => RunHandle;
  /** Push an event to all WS clients. */
  broadcast: (msg: unknown) => void;
}

interface ActiveRun {
  runId: string;
  handle: RunHandle;
}

export interface RunManager {
  launch(p: LaunchParams): { runId: string };
  interrupt(runId: string): Promise<void>;
  steer(runId: string, message: string): Promise<void>;
  activeRunId(): string | null;
}

export function createRunManager(deps: RunManagerDeps): RunManager {
  let active: ActiveRun | null = null;

  function launch(p: LaunchParams): { runId: string } {
    if (active) throw new RunActiveError("a run is already active");
    const { config, prompt, tools, runId } = deps.buildConfigAndPrompt(p);
    startRun({ runId, skill: "talent", prompt: p.spec, startedAt: Date.now() });

    const onEvent = (e: AgentEvent) => {
      deps.broadcast({ ...e, runId });
      if (e.type === "tool_call" && e.name === "store_candidate") {
        deps.broadcast({ type: "candidates_updated", runId });
      }
      const todos = detectTodos(e);
      if (todos) deps.broadcast({ type: "todos", runId, items: todos });
    };

    const handle = deps.createRun(config, { prompt, tools, onEvent });
    active = { runId, handle };

    if (handle.sessionId) setKimiSessionId(runId, handle.sessionId);

    handle.completion
      .then(res => {
        finishRun(runId, res.steps, res.tokens.total);
        deps.broadcast({ type: "done", runId, steps: res.steps, tokens: res.tokens.total });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        finishRun(runId, 0, 0, msg);
        deps.broadcast({ type: "error", runId, message: msg });
      })
      .finally(() => { if (active?.runId === runId) active = null; });

    return { runId };
  }

  async function interrupt(runId: string): Promise<void> {
    if (!active || active.runId !== runId) throw new NotActiveError("run is not active");
    await active.handle.turn.interrupt();
    deps.broadcast({ type: "interrupted", runId });
  }

  async function steer(runId: string, message: string): Promise<void> {
    if (!active || active.runId !== runId) throw new NotActiveError("run is not active");
    await active.handle.turn.steer(message);
    deps.broadcast({ type: "steer_echo", runId, message });
  }

  return { launch, interrupt, steer, activeRunId: () => active?.runId ?? null };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/web/runManager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/runManager.ts src/web/runManager.test.ts
git commit -m "feat(web): run manager with lock, interrupt, steer"
```

---

## Task 6: HTTP + WebSocket server

**Files:**
- Create: `src/server.ts`
- Test: `src/server.test.ts`

**Design note:** `server.ts` wires the real `createRun`, `talentSkill`, `defaultConfig`, and `preflight` into the run manager, holds the WS client set, and routes requests. The test starts the server on an ephemeral port with a **stub run manager** (so no CLI) to verify routing, the `409` guard, and `/api/runs`.

- [ ] **Step 1: Write failing test**

Create `src/server.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["TALENT_DB_PATH"] = join(tmpdir(), `talent-server-test-${process.pid}.db`);

let makeServer: typeof import("./server.ts").makeServer;
let mem: typeof import("./core/memory.ts");
let server: { port: number; stop: () => void };

beforeAll(async () => {
  ({ makeServer } = await import("./server.ts"));
  mem = await import("./core/memory.ts");
  mem.startRun({ runId: "srv-1", skill: "talent", prompt: "seed", startedAt: 1 });

  let launched = false;
  const stubManager = {
    launch: () => { if (launched) { const e: any = new Error("active"); e.name = "RunActiveError"; throw e; } launched = true; return { runId: "srv-live" }; },
    interrupt: async () => {},
    steer: async () => {},
    activeRunId: () => (launched ? "srv-live" : null),
  };
  server = makeServer({ port: 0, manager: stubManager as any, preflight: () => {} });
});

afterAll(() => server.stop());

test("GET /api/runs lists seeded run", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`);
  expect(res.status).toBe(200);
  const runs = await res.json();
  expect(runs.some((r: any) => r.runId === "srv-1")).toBe(true);
});

test("POST /api/runs launches, second returns 409", async () => {
  const ok = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: "ML London" }),
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()).runId).toBe("srv-live");

  const conflict = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: "again" }),
  });
  expect(conflict.status).toBe(409);
});

test("GET /api/runs/:id returns 404 for unknown", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/does-not-exist`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test src/server.test.ts`
Expected: FAIL — cannot find `makeServer`.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
#!/usr/bin/env bun
/**
 * talent-agent / server.ts
 * Local web app: serves the dossier UI, a JSON API over talent.db, and a WS live feed.
 * Bind 127.0.0.1 only — it drives the user's real Chrome via WebBridge.
 */

import type { ServerWebSocket } from "bun";
import { defaultConfig, createRun, preflight as realPreflight } from "./core/agent.ts";
import { talentSkill } from "./skills/talent/index.ts";
import { listRunsView, getRunView } from "./web/api.ts";
import { createRunManager, RunActiveError, NotActiveError, type RunManager, type LaunchParams } from "./web/runManager.ts";

const DASHBOARD = `${import.meta.dir}/../web/dashboard.html`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface ServerOptions {
  port?: number;
  manager?: RunManager;
  preflight?: () => void;
}

export function makeServer(opts: ServerOptions = {}) {
  const clients = new Set<ServerWebSocket<unknown>>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) { try { ws.send(data); } catch { /* dropped */ } }
  };

  const preflight = opts.preflight ?? realPreflight;

  const manager: RunManager = opts.manager ?? createRunManager({
    broadcast,
    createRun: (config, options) => createRun(config, options),
    buildConfigAndPrompt: (p: LaunchParams) => {
      let tools = [...talentSkill.tools];
      if (!p.notion) tools = tools.filter(t => t.name !== "save_to_notion");
      if (!p.telegram) tools = tools.filter(t => t.name !== "notify_recruiter");
      const prompt = talentSkill.buildPrompt(p.spec);
      const runId = prompt.match(/Run ID: ([^\n]+)/)?.[1] ?? `ta-${Date.now()}`;
      const config = defaultConfig({
        workDir: process.cwd(),
        thinking: p.thinking,
        agentFile: `${process.cwd()}/agent.yaml`,
        mcpConfig: `${process.cwd()}/mcp.json`,
      });
      return { config, prompt, tools, runId };
    },
  });

  const server = Bun.serve({
    port: opts.port ?? Number(process.env["PORT"] ?? 3000),
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response("ws upgrade failed", { status: 400 });
      }

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(Bun.file(DASHBOARD));
      }

      if (pathname === "/api/runs" && req.method === "GET") {
        return json(listRunsView());
      }

      if (pathname === "/api/runs" && req.method === "POST") {
        let body: Partial<LaunchParams> = {};
        try { body = await req.json(); } catch { /* empty */ }
        if (!body.spec || !String(body.spec).trim()) return json({ error: "spec is required" }, 400);
        try { preflight(); } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        try {
          const { runId } = manager.launch({
            spec: String(body.spec),
            thinking: body.thinking ?? true,
            notion: body.notion ?? true,
            telegram: body.telegram ?? true,
          });
          return json({ runId });
        } catch (e) {
          if (e instanceof RunActiveError) return json({ error: e.message, activeRunId: manager.activeRunId() }, 409);
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      const interruptMatch = pathname.match(/^\/api\/runs\/([^/]+)\/interrupt$/);
      if (interruptMatch && req.method === "POST") {
        try { await manager.interrupt(interruptMatch[1]); return json({ ok: true }); }
        catch (e) { return json({ error: (e as Error).message }, e instanceof NotActiveError ? 409 : 500); }
      }

      const steerMatch = pathname.match(/^\/api\/runs\/([^/]+)\/steer$/);
      if (steerMatch && req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { message?: string };
        if (!body.message) return json({ error: "message is required" }, 400);
        try { await manager.steer(steerMatch[1], body.message); return json({ ok: true }); }
        catch (e) { return json({ error: (e as Error).message }, e instanceof NotActiveError ? 409 : 500); }
      }

      const replayMatch = pathname.match(/^\/api\/runs\/([^/]+)\/replay$/);
      if (replayMatch && req.method === "GET") {
        return handleReplay(replayMatch[1]);
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && req.method === "GET") {
        const view = getRunView(runMatch[1]);
        return view ? json(view) : json({ error: "run not found" }, 404);
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { clients.add(ws); ws.send(JSON.stringify({ type: "hello", activeRunId: manager.activeRunId() })); },
      close(ws) { clients.delete(ws); },
      message() { /* client → server messages unused; control is via REST */ },
    },
  });

  return { port: server.port, stop: () => server.stop(true), broadcast };
}

/** Replay a finished run's stored Kimi session events as mapped AgentEvents (NDJSON). */
async function handleReplay(runId: string): Promise<Response> {
  const { parseSessionEvents } = await import("@moonshot-ai/kimi-agent-sdk");
  const { mapEvent } = await import("./core/agent.ts");
  const run = listRunsView().find(r => r.runId === runId);
  if (!run) return json({ error: "run not found" }, 404);
  if (!run.kimiSessionId) return json({ error: "no kimi session id stored for this run" }, 409);
  try {
    const events = await parseSessionEvents(process.cwd(), run.kimiSessionId);
    const mapped = events.map(mapEvent).filter(Boolean);
    return json({ runId, events: mapped });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

// Start when run directly: `bun src/server.ts`
if (import.meta.main) {
  const { port } = makeServer();
  console.log(`\x1b[1m🎯 Talent Agent web\x1b[0m → http://127.0.0.1:${port}`);
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test src/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all tests PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): Bun.serve HTTP+WS, launch/interrupt/steer/replay routes"
```

---

## Task 7: Frontend — rewire dashboard to API + WebSocket

**Files:**
- Modify: `web/dashboard.html`

**Design note:** keep the existing dossier renderer and styles. Refactor `render()` to take a candidate array, remove the embedded `RUN` object (keep a tiny offline fallback), and add a client module that boots from the API, opens the WS, drives the live console + PLAN panel + sub-agent tree, and wires the launch bar / run picker / replay.

- [ ] **Step 1: Refactor the renderer to accept data**

In the `<script>` of `web/dashboard.html`, change the render function signature and its data source. Replace `function render() {` and its first lines so it accepts a list and reads the current run meta from a module variable `STATE`:

```js
const STATE = { runId: null, candidates: [], sortKey: "score", cut: 0, meta: null };

function render() {
  const list = STATE.candidates
    .filter(c => (c.score ?? 0) >= STATE.cut)
    .sort((a, b) => STATE.sortKey === "score" ? (b.score ?? 0) - (a.score ?? 0) : a.name.localeCompare(b.name));
  document.getElementById("c-shown").textContent = list.length;
  roster.innerHTML = list.map((c, i) => entryHTML(c, i)).join("");
  // ... (keep the existing requestAnimationFrame gate-fill animation and memo-toggle wiring) ...
}
```

Extract the existing entry template into `entryHTML(c, i)` returning the same markup the current `.map(...)` produces, but guard optional blocks:
- render the `.gates` block only if `c.gates` is truthy (iterate `Object.entries(c.gates)`);
- render the memo toggle + memo only if `c.li || c.email`;
- show `c.score ?? "—"` and skip `tier-a`/signal-bar styling when `score` is null.

- [ ] **Step 2: Remove the embedded RUN object; add the API/WS client**

Delete the hard-coded `const RUN = {...}` literal. Replace the bottom bootstrap (the `render()` call and masthead hydration) with:

```js
const API = location.origin;
let ws = null;

async function boot() {
  try {
    const runs = await (await fetch(`${API}/api/runs`)).json();
    populatePicker(runs);
    if (runs.length) await loadRun(runs[0].runId);
  } catch (e) {
    console.warn("API unreachable, offline mode", e);
  }
  openWs();
  wireControls();
}

function populatePicker(runs) {
  const sel = document.getElementById("run-picker");
  sel.innerHTML = runs.map(r =>
    `<option value="${r.runId}">${r.runId} · ${r.candidateCount} cand</option>`).join("");
  sel.onchange = () => loadRun(sel.value);
}

async function loadRun(runId) {
  const view = await (await fetch(`${API}/api/runs/${runId}`)).json();
  STATE.runId = runId;
  STATE.meta = view.run;
  STATE.candidates = view.candidates;
  hydrateMasthead(view.run, view.candidates);
  render();
}

function hydrateMasthead(run, candidates) {
  document.getElementById("m-run").textContent = run.runId;
  document.getElementById("m-spec").textContent = run.prompt;
  document.getElementById("m-scored").innerHTML =
    `${candidates.filter(c => (c.score ?? 0) >= 60).length} <small>scored</small>`;
  document.getElementById("m-disc").innerHTML = `${candidates.length} <small>profiles</small>`;
}

function openWs() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(openWs, 1500);   // auto-reconnect; DB is source of truth
}

let liveStep = 0, liveTokens = 0, liveCtx = 0;
function handleEvent(e) {
  switch (e.type) {
    case "step": liveStep = e.n; updateConsole(); break;
    case "status":
      if (e.tokens) liveTokens = e.tokens.total;
      if (typeof e.contextUsage === "number") liveCtx = e.contextUsage;
      updateConsole(); break;
    case "tool_call": pushConsole(`[tool] ${e.name} ${JSON.stringify(e.input).slice(0, 80)}`); break;
    case "subagent": pushConsole(`  └ subagent: ${describeInner(e.inner)}`); break;
    case "todos": renderTodos(e.items); break;
    case "interrupted": pushConsole("■ interrupted"); break;
    case "steer_echo": pushConsole(`↳ steer: ${e.message}`); break;
    case "candidates_updated": if (e.runId === STATE.runId || !STATE.runId) loadRun(e.runId); break;
    case "done": pushConsole("✓ done"); setLaunching(false); if (e.runId) loadRun(e.runId); break;
    case "error": pushConsole(`✗ ${e.message}`); setLaunching(false); break;
  }
}

function describeInner(inner) {
  if (!inner) return "…";
  if (inner.type === "tool_call") return `[tool] ${inner.name}`;
  if (inner.type === "step") return `step ${inner.n}`;
  if (inner.type === "text") return inner.delta.slice(0, 60);
  return inner.type;
}

function updateConsole() {
  document.getElementById("live-stat").textContent =
    `step ${liveStep} · ${Math.round(liveTokens / 1000)}k tok · ctx ${Math.round((liveCtx || 0) * 100)}%`;
}
function pushConsole(line) {
  const log = document.getElementById("live-log");
  const div = document.createElement("div");
  div.textContent = line;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function renderTodos(items) {
  const mark = { done: "☑", in_progress: "▣", pending: "☐" };
  document.getElementById("plan-panel").innerHTML =
    "<div class='plan-h'>PLAN</div>" +
    items.map(t => `<div class="plan-item">${mark[t.status] || "☐"} ${t.title}</div>`).join("");
}

async function launchRun() {
  const spec = document.getElementById("spec-input").value.trim();
  if (!spec) return;
  const body = {
    spec,
    thinking: document.getElementById("tg-thinking").getAttribute("aria-pressed") === "true",
    notion: document.getElementById("tg-notion").getAttribute("aria-pressed") === "true",
    telegram: document.getElementById("tg-telegram").getAttribute("aria-pressed") === "true",
  };
  if (!confirm(`Launch run — Notion ${body.notion ? "ON" : "off"}, Telegram ${body.telegram ? "ON" : "off"}. Continue?`)) return;
  setLaunching(true);
  document.getElementById("live-log").innerHTML = "";
  const res = await fetch(`${API}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { pushConsole(`✗ ${data.error}`); setLaunching(false); return; }
  STATE.runId = data.runId;
}

async function stopRun() {
  if (STATE.runId) await fetch(`${API}/api/runs/${STATE.runId}/interrupt`, { method: "POST" });
}
async function steerRun() {
  const input = document.getElementById("steer-input");
  const message = input.value.trim();
  if (!message || !STATE.runId) return;
  await fetch(`${API}/api/runs/${STATE.runId}/steer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }),
  });
  input.value = "";
}
async function replayRun() {
  if (!STATE.runId) return;
  const res = await fetch(`${API}/api/runs/${STATE.runId}/replay`);
  const data = await res.json();
  if (!res.ok) { pushConsole(`✗ replay: ${data.error}`); return; }
  document.getElementById("live-log").innerHTML = "";
  for (const e of data.events) { handleEvent(e); await new Promise(r => setTimeout(r, 40)); }
}

function setLaunching(on) {
  document.getElementById("launch-btn").disabled = on;
  document.getElementById("stop-btn").style.display = on ? "" : "none";
}

function wireControls() {
  document.getElementById("launch-btn").onclick = launchRun;
  document.getElementById("stop-btn").onclick = stopRun;
  document.getElementById("steer-btn").onclick = steerRun;
  document.getElementById("replay-btn").onclick = replayRun;
  document.querySelectorAll(".toggle-chip").forEach(c =>
    c.onclick = () => c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true"));
  // existing sort/cut chip handlers already update STATE.sortKey / STATE.cut then call render()
}

boot();
```

- [ ] **Step 3: Add the launch bar, live console, PLAN panel, run picker markup**

In the `<body>`, after the masthead `</header>` and before the `.controls` nav, insert:

```html
<section class="launch-bar">
  <input id="spec-input" placeholder="Job spec — e.g. Senior ML Engineer PyTorch London" />
  <button class="toggle-chip" id="tg-thinking" aria-pressed="true">thinking</button>
  <button class="toggle-chip" id="tg-notion" aria-pressed="true">notion</button>
  <button class="toggle-chip" id="tg-telegram" aria-pressed="true">telegram</button>
  <button class="launch-go" id="launch-btn">▶ LAUNCH</button>
  <button class="launch-stop" id="stop-btn" style="display:none">■ STOP</button>
</section>

<section class="live-strip">
  <div class="live-main">
    <div id="live-stat" class="live-stat">idle</div>
    <div id="live-log" class="live-log"></div>
    <div class="steer-row">
      <input id="steer-input" placeholder="steer the agent — e.g. only London, skip recruiters" />
      <button id="steer-btn">↑ steer</button>
      <button id="replay-btn">⏮ replay</button>
    </div>
  </div>
  <aside id="plan-panel" class="plan-panel"></aside>
</section>
```

In the masthead `.title-meta`, add a run picker line:

```html
<br /><select id="run-picker" class="run-picker"></select>
```

- [ ] **Step 4: Add styles for the new pieces**

In the `<style>`, add (reusing existing CSS variables):

```css
.launch-bar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:24px 0 4px; padding-bottom:18px; border-bottom:1px solid var(--line); }
#spec-input { flex:1; min-width:260px; font-family:var(--font-mono); font-size:13px; padding:10px 12px; background:var(--paper-2); border:1px solid var(--line); color:var(--ink); }
.toggle-chip { font-family:var(--font-mono); font-size:11px; text-transform:uppercase; letter-spacing:.1em; padding:8px 12px; border:1px solid var(--line); background:transparent; color:var(--ink-soft); cursor:pointer; }
.toggle-chip[aria-pressed="true"] { background:var(--ink); color:var(--paper); border-color:var(--ink); }
.launch-go { font-family:var(--font-mono); font-weight:700; letter-spacing:.12em; padding:9px 18px; background:var(--signal); color:var(--paper); border:none; cursor:pointer; }
.launch-go:disabled { opacity:.4; cursor:default; }
.launch-stop { font-family:var(--font-mono); font-weight:700; padding:9px 14px; background:transparent; color:var(--signal); border:2px solid var(--signal); cursor:pointer; }
.live-strip { display:grid; grid-template-columns:1fr 220px; gap:18px; margin:14px 0 26px; }
.live-stat { font-family:var(--font-mono); font-size:12px; color:var(--signal-deep); margin-bottom:8px; letter-spacing:.08em; }
.live-log { font-family:var(--font-mono); font-size:11.5px; line-height:1.6; color:var(--ink-soft); max-height:150px; overflow:auto; background:var(--paper-2); border:1px solid var(--line); padding:10px 12px; white-space:pre-wrap; }
.steer-row { display:flex; gap:8px; margin-top:10px; }
.steer-row input { flex:1; font-family:var(--font-mono); font-size:12px; padding:8px 10px; background:var(--paper-2); border:1px solid var(--line); color:var(--ink); }
.steer-row button { font-family:var(--font-mono); font-size:11px; padding:8px 12px; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer; }
.plan-panel { font-family:var(--font-mono); font-size:11.5px; background:var(--paper-2); border:1px solid var(--line); padding:12px; }
.plan-h { letter-spacing:.24em; color:var(--ink-faint); font-size:10px; margin-bottom:8px; }
.plan-item { line-height:1.7; }
.run-picker { font-family:var(--font-mono); font-size:11px; background:var(--paper-2); border:1px solid var(--line); color:var(--ink); padding:3px 6px; margin-top:6px; }
@media (max-width:720px){ .live-strip{ grid-template-columns:1fr; } }
```

- [ ] **Step 5: Manual verification**

```bash
bun run web
```
Open `http://127.0.0.1:3000`. Verify:
1. Past runs appear in the picker; selecting one renders its dossier.
2. Type a spec, set toggles, click LAUNCH → confirm dialog → live console shows `step … · …k tok · ctx …%` advancing, tool lines appear, PLAN panel fills, candidates stream into the dossier.
3. `■ STOP` halts the run; a steer message echoes `↳ steer: …`.
4. After completion, `⏮ replay` re-streams the console.

(Requires the `kimi` CLI logged in + WebBridge on :10086.)

- [ ] **Step 6: Commit**

```bash
git add web/dashboard.html
git commit -m "feat(web): launch/live/steer/replay UI wired to API + WebSocket"
```

---

## Task 8: Wire-up script + docs

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add the web script**

In `package.json` `scripts`, add:

```json
    "web": "bun src/server.ts",
```

- [ ] **Step 2: Document usage in README.md**

Add a section:

```markdown
## Web UI

Run the local app (drives your real logged-in Chrome via WebBridge — local only):

\`\`\`bash
bun run web        # → http://127.0.0.1:3000
\`\`\`

Launch a run, watch it live (steps/tokens/tools/candidates/sub-agents/todos), stop or steer it mid-run, and browse or replay past runs. Requires the \`kimi\` CLI (\`kimi login\`) and WebBridge on port 10086.
```

- [ ] **Step 3: Full verification**

Run: `bun test && bunx tsc --noEmit`
Expected: all tests PASS, tsc exits 0.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "chore: add web script and docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Local-bind + single-run lock → Task 5 (manager) + Task 6 (`hostname:"127.0.0.1"`). ✓
- In-process `runAgent`/`createRun` reuse → Task 3, Task 6. ✓
- API routes (`/api/runs` GET/POST, `/:id`, interrupt, steer, replay, `/ws`) → Task 6. ✓
- Candidates stream via `store_candidate` detection → Task 5 (`onEvent`). ✓
- `normalizeCandidate` graceful degradation → Task 4. ✓
- Toggles map to thinking + tool filtering, defaults all ON → Task 6 `buildConfigAndPrompt` + `??` defaults; UI Task 7. ✓
- Interrupt/steer via `turn` → Task 3 (handle) + Task 5 + Task 6. ✓
- Sub-agents / interrupted / todos events → Task 2 (`mapEvent`, `detectTodos`). ✓
- Replay via `parseSessionEvents` + persisted `kimi_session_id` → Task 1 + Task 6. ✓
- Tests for normalizer, lock guard, mapEvent, session-id round-trip, route guards → Tasks 1,2,4,5,6. ✓
- Frontend launch bar / live console / PLAN / sub-agent tree / picker / replay → Task 7. ✓

**Placeholder scan:** none — every code step contains full code.

**Type consistency:** `RunHandle{sessionId,turn,completion}` (Task 3) used identically in Tasks 5/6. `CandidateView`/`normalizeCandidate` (Task 4) match `getRunView` (Task 4) and frontend `entryHTML` fields (Task 7). `AgentEvent` additions (Task 2) consumed in Task 5 (`detectTodos`) and Task 7 (`handleEvent`). `LaunchParams` consistent across Tasks 5/6. ✓
