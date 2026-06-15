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

test("normalizeCandidate extracts gates from nested scoring.gates, dropping non-numeric", () => {
  const row = {
    id: "n", linkedin_url: "https://linkedin.com/in/n", name: "Nia", headline: null,
    location: null, current_role: null, current_company: null, skills: null,
    experience: null, summary: null, fit_score: 80,
    scoring_json: JSON.stringify({ gates: { Skills: 90, Seniority: "n/a" } }),
    outreach_json: null, notion_page_id: null, run_id: "r1",
  };
  const c = api.normalizeCandidate(row as any);
  expect(c.gates).toEqual({ Skills: 90 }); // nested path used; string-valued gate excluded
});

test("normalizeCandidate guards wrong-typed outreach fields", () => {
  const row = {
    id: "w", linkedin_url: "https://linkedin.com/in/w", name: "Wu", headline: null,
    location: null, current_role: null, current_company: null, skills: null,
    experience: null, summary: null, fit_score: null,
    scoring_json: null,
    outreach_json: JSON.stringify({ personalHook: 42, linkedinMessage: { x: 1 }, emailBody: ["a"] }),
    notion_page_id: null, run_id: "r1",
  };
  const c = api.normalizeCandidate(row as any);
  expect(c.hook).toBe("");   // number → fallback, not 42
  expect(c.li).toBeNull();   // object → null
  expect(c.email).toBeNull(); // array → null
});

test("normalizeCandidate maps the agent's gateN_* scoring keys to canonical labels", () => {
  const row = {
    id: "g", linkedin_url: "https://linkedin.com/in/g", name: "Gita", headline: null,
    location: null, current_role: null, current_company: null, skills: null,
    experience: null, summary: null, fit_score: 90,
    scoring_json: JSON.stringify({
      gate1_skills: 90, gate2_seniority: 90, gate3_location: 100, gate4_recency: 85, gate5_standout: 80,
      reasoning: "…",
    }),
    outreach_json: null, notion_page_id: null, run_id: "r1",
  };
  const c = api.normalizeCandidate(row as any);
  expect(c.gates).toEqual({ Skills: 90, Seniority: 90, Location: 100, Recency: 85, Standout: 80 });
});

test("normalizeCandidate derives skills, seniority, years, contacts (best-effort)", () => {
  const nowMs = new Date(2026, 5, 8).getTime();
  const row = {
    id: "d", linkedin_url: "https://linkedin.com/in/d", name: "Dev",
    headline: "Senior Machine Learning Engineer", location: "London",
    current_role: "Senior ML Engineer", current_company: "Acme",
    skills: '["Python","PyTorch","NLP"]',
    experience: JSON.stringify([
      { title: "Senior ML Engineer", company: "Acme", duration: "Jan 2021 - Present" },
      { title: "ML Engineer", company: "Beta", duration: "Jun 2018 - Dec 2020" },
    ]),
    summary: "ML engineer.", fit_score: 80, scoring_json: null, outreach_json: null,
    contacts_json: JSON.stringify({ email: "dev@x.com", phone: "123" }),
    notion_page_id: null, run_id: "r1",
  };
  const c = api.normalizeCandidate(row as any, nowMs);
  expect(c.skills).toEqual(["Python", "PyTorch", "NLP"]);
  expect(c.seniority).toBe("Senior");
  expect(c.years).toBe(8);                                  // 2018 → 2026 span
  expect(c.contacts).toEqual({ email: "dev@x.com", phone: "123" });
});

test("deriveYears prefers an explicit 'N+ years' in the summary", () => {
  expect(api.deriveYears([], "Senior ML Engineer with 5+ years in production ML", 0)).toBe(5);
});

test("deriveSeniority buckets common titles", () => {
  expect(api.deriveSeniority("Staff Software Engineer", "")).toBe("Staff");
  expect(api.deriveSeniority("Engineering Manager", "")).toBe("Lead");
  expect(api.deriveSeniority("Senior ML Engineer", "")).toBe("Senior");
  expect(api.deriveSeniority("ML Engineer Intern", "")).toBe("Junior");
  expect(api.deriveSeniority("Machine Learning Engineer", "")).toBe("Mid");
});

test("normalizeCandidate has empty skills / null contacts when absent", () => {
  const c = api.normalizeCandidate({
    id: "e", linkedin_url: "https://linkedin.com/in/e", name: "E", headline: null,
    location: null, current_role: null, current_company: null, skills: null,
    experience: null, summary: null, fit_score: null, scoring_json: null,
    outreach_json: null, contacts_json: null, notion_page_id: null, run_id: "r1",
  } as any);
  expect(c.skills).toEqual([]);
  expect(c.contacts).toBeNull();
  expect(c.years).toBeNull();
  expect(c.seniority).toBe("Mid");
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
