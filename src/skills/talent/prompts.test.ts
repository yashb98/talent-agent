import { test, expect } from "bun:test";
import { buildTalentPrompt } from "./prompts.ts";

test("buildTalentPrompt embeds runId + spec, and omits the JD block when absent", () => {
  const p = buildTalentPrompt("Senior ML Engineer London", "ml-eng-jun08-1", 5);
  expect(p).toContain("Run ID: ml-eng-jun08-1");
  expect(p).toContain("Senior ML Engineer London");
  expect(p).not.toContain("Full Job Description");
});

test("buildTalentPrompt includes the JD block + scoring reference when provided", () => {
  const jd = "Must have: Python, PyTorch, 5+ years. Nice to have: NLP, recsys.";
  const p = buildTalentPrompt("Senior ML Engineer London", "id-1", 5, jd);
  expect(p).toContain("Full Job Description");
  expect(p).toContain(jd);
  expect(p).toContain("job description"); // discovery + score steps reference it
});

test("buildTalentPrompt ignores a blank JD", () => {
  const p = buildTalentPrompt("Staff SWE", "id-2", 5, "   ");
  expect(p).not.toContain("Full Job Description");
});
