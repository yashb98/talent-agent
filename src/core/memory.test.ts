/**
 * Tests for the candidate persistence merge logic.
 * Uses an isolated temp DB so the real data/talent.db is never touched.
 */

import { test, expect, beforeAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the memory module at a throwaway DB BEFORE importing it (DB_PATH is
// read at module load time).
process.env["TALENT_DB_PATH"] = join(tmpdir(), `talent-test-${process.pid}.db`);

let mem: typeof import("./memory.ts");

beforeAll(async () => {
  mem = await import("./memory.ts");
});

test("multi-call store_candidate merges instead of clobbering", () => {
  const url = "https://www.linkedin.com/in/jane-merge";
  const id = "test-jane";

  // 1. SCRAPE call — full profile, no score/outreach yet.
  mem.upsertCandidate(id, url, {
    name: "Jane Doe",
    headline: "Senior ML Engineer",
    location: "London",
    skills: ["python", "pytorch"],
  }, "run-1");

  // 2. SCORE call — only fitScore + scoring. The old code nulled name/skills here.
  mem.upsertCandidate(id, url, {
    fitScore: 88,
    scoring: { g1: 90, g2: 85 },
  }, "run-1");

  // 3. OUTREACH call — only outreach. Must still preserve everything above.
  mem.upsertCandidate(id, url, {
    outreach: { linkedinMessage: "hi" },
  }, "run-1");

  const row = mem.getDb()
    .query("SELECT * FROM candidates WHERE linkedin_url=?")
    .get(url) as Record<string, unknown>;

  expect(row["name"]).toBe("Jane Doe");          // survived score+outreach calls
  expect(row["headline"]).toBe("Senior ML Engineer");
  expect(row["fit_score"]).toBe(88);             // survived outreach call
  expect(row["skills"]).toBe(JSON.stringify(["python", "pytorch"]));
  expect(row["scoring_json"]).toBe(JSON.stringify({ g1: 90, g2: 85 }));
  expect(row["outreach_json"]).toBe(JSON.stringify({ linkedinMessage: "hi" }));
});

test("setNotionPageId persists the page id", () => {
  const url = "https://www.linkedin.com/in/john-notion";
  mem.upsertCandidate("test-john", url, { name: "John", fitScore: 70 }, "run-1");
  mem.setNotionPageId(url, "page-abc-123");

  const row = mem.getDb()
    .query("SELECT notion_page_id, name, fit_score FROM candidates WHERE linkedin_url=?")
    .get(url) as Record<string, unknown>;

  expect(row["notion_page_id"]).toBe("page-abc-123");
  expect(row["name"]).toBe("John");   // setter must not disturb other fields
  expect(row["fit_score"]).toBe(70);
});

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

test("nextRunId builds a readable slug-date-counter id and increments per (slug,date)", () => {
  const t = new Date(2026, 5, 8, 12).getTime(); // Jun 8 2026, local
  const id1 = mem.nextRunId("Staff SWE London", t);
  expect(id1).toMatch(/^staff-swe-london-[a-z]{3}\d{2}-1$/);
  mem.startRun({ runId: id1, skill: "talent", prompt: "Staff SWE London", startedAt: t });
  const id2 = mem.nextRunId("Staff SWE London", t);
  expect(id2).toBe(id1.replace(/-1$/, "-2"));
  // a different role on the same day starts its own counter at 1
  expect(mem.nextRunId("Data Scientist Berlin", t)).toMatch(/^data-scientist-berlin-[a-z]{3}\d{2}-1$/);
});

test("nextRunId slug strips punctuation and caps length", () => {
  const id = mem.nextRunId("C++ / Rust  —  Senior!!! Distributed Systems Engineer @ Berlin", 0);
  expect(id.split("-").length).toBeGreaterThan(3);
  expect(id).toMatch(/^[a-z0-9-]+-[a-z]{3}\d{2}-\d+$/);
});

test("updateOutreach merges into outreach_json without clobbering other fields", () => {
  const url = "https://www.linkedin.com/in/edit-me";
  mem.upsertCandidate("edit1", url, { name: "Edit", outreach: { linkedinMessage: "orig", personalHook: "hook" } }, "run-edit");
  const ok = mem.updateOutreach(url, { linkedinMessage: "edited note" });
  expect(ok).toBe(true);
  const row = mem.getDb().query("SELECT outreach_json FROM candidates WHERE linkedin_url=?").get(url) as any;
  const oj = JSON.parse(row.outreach_json);
  expect(oj.linkedinMessage).toBe("edited note");
  expect(oj.personalHook).toBe("hook");          // preserved
  expect(mem.updateOutreach("https://nope", { linkedinMessage: "x" })).toBe(false);
});

test("setOutreachStatus + store_candidate outreachStatus round-trip", () => {
  const url = "https://www.linkedin.com/in/status-me";
  mem.upsertCandidate("st1", url, { name: "St", fitScore: 80 }, "run-st");
  mem.setOutreachStatus(url, "sent");
  let row = mem.getDb().query("SELECT outreach_status FROM candidates WHERE linkedin_url=?").get(url) as any;
  expect(row.outreach_status).toBe("sent");
  // a later partial upsert (no outreachStatus) must not clobber it
  mem.upsertCandidate("st1", url, { name: "St", outreach: { linkedinMessage: "hi" } }, "run-st");
  row = mem.getDb().query("SELECT outreach_status FROM candidates WHERE linkedin_url=?").get(url) as any;
  expect(row.outreach_status).toBe("sent");
});

test("kimi_session_id round-trips", () => {
  mem.startRun({ runId: "r-400", skill: "talent", prompt: "spec", startedAt: 400 });
  mem.setKimiSessionId("r-400", "kimi-sess-xyz");
  const run = mem.listRuns().find(r => r.runId === "r-400")!;
  expect(run.kimiSessionId).toBe("kimi-sess-xyz");
});
