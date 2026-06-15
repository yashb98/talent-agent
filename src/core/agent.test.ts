import { test, expect } from "bun:test";
import { mapEvent, detectTodos, createEventAssembler } from "./agent.ts";

test("assembler reassembles tool-call arguments from streamed ToolCallParts", () => {
  const a = createEventAssembler();
  const out: any[] = [];
  // ToolCall arrives with empty args, then args stream as parts, then the next event flushes it.
  out.push(...a.push({ type: "ToolCall", payload: { function: { name: "SearchWeb", arguments: "" } } } as any));
  out.push(...a.push({ type: "ToolCallPart", payload: { arguments_part: '{"query":"ML ' } } as any));
  out.push(...a.push({ type: "ToolCallPart", payload: { arguments_part: 'London"}' } } as any));
  // a non-tool event flushes the pending call (with full input) BEFORE mapping itself
  out.push(...a.push({ type: "StepBegin", payload: { n: 5 } } as any));
  expect(out).toEqual([
    { type: "tool_call", name: "SearchWeb", input: { query: "ML London" } },
    { type: "step", n: 5 },
  ]);
});

test("assembler flush emits a trailing tool call at end of stream", () => {
  const a = createEventAssembler();
  expect(a.push({ type: "ToolCall", payload: { function: { name: "Shell", arguments: "{}" } } } as any)).toEqual([]);
  expect(a.flush()).toEqual([{ type: "tool_call", name: "Shell", input: {} }]);
});

test("assembler passes non-tool events straight through mapEvent", () => {
  const a = createEventAssembler();
  expect(a.push({ type: "ContentPart", payload: { type: "text", text: "hi" } } as any))
    .toEqual([{ type: "text", delta: "hi" }]);
});

test("StepInterrupted maps to interrupted", () => {
  expect(mapEvent({ type: "StepInterrupted", payload: {} } as any))
    .toEqual({ type: "interrupted" });
});

test("ToolResult with a todo display block (real return_value nesting) maps to todos", () => {
  // Matches the confirmed runtime wire shape from a live SetTodoList result.
  const raw = {
    type: "ToolResult",
    payload: {
      tool_call_id: "tc-1",
      return_value: {
        is_error: false,
        output: "Todo list updated",
        message: "Todo list updated",
        display: [{ type: "todo", items: [{ title: "Step 1 - DISCOVER", status: "in_progress" }] }],
      },
    },
  };
  expect(mapEvent(raw as any)).toEqual({
    type: "todos",
    items: [{ title: "Step 1 - DISCOVER", status: "in_progress" }],
  });
});

test("ToolResult reads output/name from return_value; tool_call_id is the name", () => {
  const raw = {
    type: "ToolResult",
    payload: { tool_call_id: "tc-2", return_value: { is_error: false, output: "stored", display: [{ type: "text" }] } },
  };
  expect(mapEvent(raw as any)).toEqual({ type: "tool_result", name: "tc-2", output: "stored" });
});

test("ToolResult still handles legacy top-level shape (fallback)", () => {
  const raw = { type: "ToolResult", payload: { id: "tc-3", output: "ok" } };
  expect(mapEvent(raw as any)).toEqual({ type: "tool_result", name: "tc-3", output: "ok" });
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
