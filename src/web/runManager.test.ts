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

test("sendOutreach shares the lock and broadcasts outreach_done on completion", async () => {
  const fk = fakeHandle();
  const msgs: any[] = [];
  const mgr = rm.createRunManager({
    createRun: () => fk.handle as any,
    broadcast: (m: any) => msgs.push(m),
    buildConfigAndPrompt: () => ({ config: {} as any, prompt: "p", tools: [], runId: "ra-x" }),
    buildSendJob: () => ({ config: {} as any, prompt: "send", tools: [], jobId: "send-1" }),
  });
  const { jobId } = mgr.sendOutreach({ runId: "ra-x", linkedinUrl: "https://lnkd/in/a", name: "A", note: "hi" });
  expect(jobId).toBe("send-1");
  expect(mgr.activeRunId()).toBe("send-1");
  // a launch can't start while a send is active
  expect(() => mgr.launch({ spec: "y", thinking: false, notion: false, telegram: false })).toThrow(rm.RunActiveError);
  fk.finish();
  await fk.handle.completion; await new Promise(r => setTimeout(r, 10));
  expect(mgr.activeRunId()).toBeNull();
  expect(msgs.some(m => m.type === "outreach_done" && m.ok === true && m.linkedinUrl === "https://lnkd/in/a")).toBe(true);
});

test("sendOutreach throws if not configured", () => {
  const mgr = rm.createRunManager({
    createRun: () => fakeHandle().handle as any,
    broadcast: () => {},
    buildConfigAndPrompt: () => ({ config: {} as any, prompt: "p", tools: [], runId: "r" }),
  });
  expect(() => mgr.sendOutreach({ runId: "r", linkedinUrl: "u", name: "n", note: "x" })).toThrow();
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
  await new Promise(r => setTimeout(r, 10));   // let the completion .then/.finally chain settle
  expect(mgr.activeRunId()).toBeNull();
});

test("onEvent forwards events, candidates_updated, and todos to broadcast", () => {
  const broadcasts: any[] = [];
  const fk = fakeHandle();
  let onEvent!: (e: any) => void;
  const mgr = rm.createRunManager({
    createRun: (_c: any, opts: any) => { onEvent = opts.onEvent; return fk.handle as any; },
    broadcast: (m: any) => broadcasts.push(m),
    buildConfigAndPrompt: () => ({ config: {} as any, prompt: "p", tools: [], runId: "ra-fwd" }),
  });
  mgr.launch({ spec: "x", thinking: false, notion: false, telegram: false });

  // Every event is tagged with runId and forwarded.
  onEvent({ type: "step", n: 3 });
  expect(broadcasts).toContainEqual({ type: "step", n: 3, runId: "ra-fwd" });

  // store_candidate tool call yields a candidates_updated nudge (plus the raw event).
  onEvent({ type: "tool_call", name: "store_candidate", input: {} });
  expect(broadcasts).toContainEqual({ type: "candidates_updated", runId: "ra-fwd" });

  // SetTodoList tool call yields a todos broadcast via detectTodos.
  onEvent({ type: "tool_call", name: "SetTodoList", input: { items: [{ title: "discover", status: "done" }] } });
  expect(broadcasts).toContainEqual({ type: "todos", runId: "ra-fwd", items: [{ title: "discover", status: "done" }] });
});
