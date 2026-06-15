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
  skills: string[];
  seniority: string;            // best-effort: Junior | Mid | Senior | Staff | Lead
  years: number | null;         // best-effort years of experience
  contacts: Record<string, unknown> | null;
  outreachStatus: string | null; // null | sent | failed | sending
}

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

/** Return v only when it is a string, else the fallback (guards against wrong-typed JSON). */
function asString(v: unknown, fallback: string): string;
function asString(v: unknown, fallback: null): string | null;
function asString(v: unknown, fallback: string | null): string | null {
  return typeof v === "string" ? v : fallback;
}

// ── Best-effort attribute derivation (no agent change) ──────────────────────

/** Coarse seniority bucket from the title/headline keywords. */
export function deriveSeniority(role: string, headline: string): string {
  const s = `${role} ${headline}`.toLowerCase();
  if (/\b(principal|distinguished|fellow|staff)\b/.test(s)) return "Staff";
  if (/\b(head|director|vp|vice president|chief|cto|lead|manager)\b/.test(s)) return "Lead";
  if (/\b(senior|sr\.?)\b/.test(s)) return "Senior";
  if (/\b(junior|jr\.?|intern|graduate|trainee|apprentice|entry)\b/.test(s)) return "Junior";
  return "Mid";
}

const MONTH_IDX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function parseMonthYear(s: string, nowMs: number): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (/present|current|now|today/.test(t)) return nowMs;
  const m = t.match(/([a-z]{3,})\.?\s+(\d{4})/);
  if (m && MONTH_IDX[m[1].slice(0, 3)] !== undefined) return new Date(Number(m[2]), MONTH_IDX[m[1].slice(0, 3)], 1).getTime();
  const y = t.match(/\b(\d{4})\b/);
  if (y) return new Date(Number(y[1]), 0, 1).getTime();
  return null;
}

/** Best-effort years of experience: prefer an explicit "N+ years" in the summary,
 *  else the career span from earliest experience start to latest end (or now). */
export function deriveYears(experience: unknown, summary: string | null, nowMs: number): number | null {
  const m = String(summary ?? "").match(/(\d{1,2})\s*\+?\s*years?/i);
  if (m) return Number(m[1]);
  if (Array.isArray(experience)) {
    let earliest = Infinity, latest = -Infinity;
    for (const e of experience) {
      const dur = e && typeof e === "object"
        ? String((e as any).duration ?? (e as any).dates ?? (e as any).period ?? "") : "";
      if (!dur) continue;
      const parts = dur.split(/[-–—]/);
      const start = parseMonthYear(parts[0] ?? "", nowMs);
      const end = parseMonthYear(parts[1] ?? parts[0] ?? "", nowMs);
      if (start != null) earliest = Math.min(earliest, start);
      if (end != null) latest = Math.max(latest, end);
    }
    if (isFinite(earliest) && isFinite(latest) && latest > earliest) {
      return Math.max(1, Math.round((latest - earliest) / (365.25 * 24 * 3600 * 1000)));
    }
  }
  return null;
}

export function normalizeCandidate(row: CandidateFull, nowMs: number = Date.now()): CandidateView {
  const scoring = safeParse<Record<string, unknown>>(row.scoring_json);
  const outreach = safeParse<Record<string, unknown>>(row.outreach_json);

  // Gates: the agent emits gate1_skills/gate2_seniority/... (confirmed at runtime),
  // but older/manual data may use PascalCase or a nested `gates` object. Accept all,
  // normalizing to the canonical labels the dashboard's GATE_WEIGHT map expects.
  const gateSource = (scoring?.["gates"] as Record<string, unknown>) ?? scoring;
  let gates: Record<string, number> | null = null;
  if (gateSource) {
    const aliases: Record<string, string> = {
      Skills: "Skills", Seniority: "Seniority", Location: "Location", Recency: "Recency", Standout: "Standout",
      gate1_skills: "Skills", gate2_seniority: "Seniority", gate3_location: "Location",
      gate4_recency: "Recency", gate5_standout: "Standout",
    };
    const picked: Record<string, number> = {};
    for (const [srcKey, label] of Object.entries(aliases)) {
      const v = gateSource[srcKey];
      if (typeof v === "number" && !(label in picked)) picked[label] = v;
    }
    if (Object.keys(picked).length > 0) gates = picked;
  }

  const skillsRaw = safeParse<unknown>(row.skills);
  const skills = Array.isArray(skillsRaw) ? skillsRaw.filter((s): s is string => typeof s === "string") : [];
  const experience = safeParse<unknown>(row.experience);
  const contacts = safeParse<Record<string, unknown>>(row.contacts_json);

  return {
    id: row.id,
    name: row.name ?? "Unknown",
    score: typeof row.fit_score === "number" ? row.fit_score : null,
    role: row.current_role ?? "",
    company: row.current_company ?? "",
    loc: row.location ?? "",
    url: row.linkedin_url,
    hook: asString(outreach?.["personalHook"], ""),
    li: asString(outreach?.["linkedinMessage"], null),
    email: asString(outreach?.["emailBody"], null),
    gates,
    notion: !!row.notion_page_id,
    skills,
    seniority: deriveSeniority(row.current_role ?? "", row.headline ?? ""),
    years: deriveYears(experience, row.summary, nowMs),
    contacts: contacts && Object.keys(contacts).length > 0 ? contacts : null,
    outreachStatus: row.outreach_status ?? null,
  };
}

export function listRunsView(): RunSummary[] {
  return listRuns();
}

export function getRunView(runId: string): { run: RunSummary; candidates: CandidateView[] } | null {
  const run = listRuns().find(r => r.runId === runId);
  if (!run) return null;
  const candidates = getRunCandidates(runId).map(c => normalizeCandidate(c));
  return { run, candidates };
}
