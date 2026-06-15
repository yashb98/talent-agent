import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["TALENT_DB_PATH"] = join(tmpdir(), `talent-server-test-${process.pid}.db`);

let makeServer: typeof import("./server.ts").makeServer;
let mem: typeof import("./core/memory.ts");
let RunActiveError: typeof import("./web/runManager.ts").RunActiveError;
let NotActiveError: typeof import("./web/runManager.ts").NotActiveError;
let server: { port: number; stop: () => void };

beforeAll(async () => {
  ({ makeServer } = await import("./server.ts"));
  mem = await import("./core/memory.ts");
  ({ RunActiveError, NotActiveError } = await import("./web/runManager.ts"));
  mem.startRun({ runId: "srv-1", skill: "talent", prompt: "seed", startedAt: 1 });
  mem.upsertCandidate("cand-1", "https://www.linkedin.com/in/test", { name: "Test Cand", outreach: { linkedinMessage: "hi there" } }, "srv-1");

  let launched = false;
  const stubManager = {
    launch: () => { if (launched) throw new RunActiveError("a run is already active"); launched = true; return { runId: "srv-live" }; },
    sendOutreach: () => ({ jobId: "send-1" }),
    // interrupt/steer succeed for the active run, throw NotActiveError otherwise.
    interrupt: async (id: string) => { if (!launched || id !== "srv-live") throw new NotActiveError("not active"); },
    steer: async (id: string) => { if (!launched || id !== "srv-live") throw new NotActiveError("not active"); },
    activeRunId: () => (launched ? "srv-live" : null),
  };
  server = makeServer({ port: 0, manager: stubManager as any, preflight: () => {} });
});

afterAll(() => server.stop());

const B = () => `http://127.0.0.1:${server.port}`;

test("POST .../candidate/:cid/outreach edits + persists the note", async () => {
  const res = await fetch(`${B()}/api/runs/srv-1/candidate/cand-1/outreach`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ linkedinMessage: "edited note!" }),
  });
  expect(res.status).toBe(200);
  const view = await (await fetch(`${B()}/api/runs/srv-1`)).json() as any;
  expect(view.candidates.find((c: any) => c.id === "cand-1").li).toBe("edited note!");
});

test("POST .../send returns a jobId for a candidate with a note", async () => {
  const res = await fetch(`${B()}/api/runs/srv-1/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: "cand-1" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json() as any).jobId).toBe("send-1");
});

test("POST .../send 404 for an unknown candidate", async () => {
  const res = await fetch(`${B()}/api/runs/srv-1/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: "nope" }),
  });
  expect(res.status).toBe(404);
});

test("GET /api/runs lists seeded run", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`);
  expect(res.status).toBe(200);
  const runs = await res.json() as any[];
  expect(runs.some((r: any) => r.runId === "srv-1")).toBe(true);
});

test("POST /api/runs launches, second returns 409", async () => {
  const ok = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: "ML London" }),
  });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as any).runId).toBe("srv-live");

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

test("GET /api/runs/:id returns 200 for an existing run", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/srv-1`);
  expect(res.status).toBe(200);
  const view = await res.json() as any;
  expect(view.run.runId).toBe("srv-1");
  expect(Array.isArray(view.candidates)).toBe(true);
});

test("POST /api/runs without spec returns 400", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});

test("POST /api/runs/:id/interrupt routes to the active run; wrong id 409", async () => {
  const ok = await fetch(`http://127.0.0.1:${server.port}/api/runs/srv-live/interrupt`, { method: "POST" });
  expect(ok.status).toBe(200);
  const wrong = await fetch(`http://127.0.0.1:${server.port}/api/runs/nope/interrupt`, { method: "POST" });
  expect(wrong.status).toBe(409);
});

test("POST /api/runs/:id/steer requires a message", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/srv-live/steer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});
