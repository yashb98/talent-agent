/**
 * talent-agent / core / memory.ts
 * Persistent bun:sqlite memory for run logs and key-value cache.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { RunLog, CacheEntry } from "./types.ts";

/** Read the DB path lazily so tests can point each file at its own temp DB. */
function dbPath(): string {
  return process.env["TALENT_DB_PATH"] ?? "./data/talent.db";
}

let _db: Database | null = null;
let _openPath: string | null = null;

export function getDb(): Database {
  const path = dbPath();
  // Reopen when the target path changes (test isolation: each test file sets
  // its own TALENT_DB_PATH; without this the first file's DB leaks into all).
  if (_db && _openPath === path) return _db;
  if (_db) { _db.close(); _db = null; }
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path, { create: true });
  _db.exec("PRAGMA journal_mode=WAL;");
  initSchema(_db);
  _openPath = path;
  return _db;
}

/** Close the cached connection (test helper / clean shutdown). */
export function closeDb(): void {
  if (_db) { _db.close(); _db = null; _openPath = null; }
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_log (
      run_id TEXT PRIMARY KEY,
      skill TEXT NOT NULL,
      prompt TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      steps INTEGER DEFAULT 0,
      tokens_total INTEGER DEFAULT 0,
      error TEXT,
      kimi_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ttl_hours INTEGER NOT NULL DEFAULT 168
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      linkedin_url TEXT NOT NULL UNIQUE,
      name TEXT,
      headline TEXT,
      location TEXT,
      current_role TEXT,
      current_company TEXT,
      skills TEXT,           -- JSON array
      experience TEXT,       -- JSON array
      summary TEXT,
      fit_score REAL,
      scoring_json TEXT,     -- full ScoringOutput JSON
      outreach_json TEXT,    -- OutreachDraft JSON
      contacts_json TEXT,    -- { email?, phone?, websites?, twitter?, ... } when connected
      outreach_status TEXT,  -- null | sent | failed (+ method/time live in the JSON value)
      notion_page_id TEXT,
      run_id TEXT,
      scraped_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Migrations: add columns to pre-existing DBs that predate them.
  const runCols = db.query<{ name: string }, []>(`PRAGMA table_info(run_log)`).all();
  if (!runCols.some(c => c.name === "kimi_session_id")) {
    db.exec(`ALTER TABLE run_log ADD COLUMN kimi_session_id TEXT`);
  }
  const candCols = db.query<{ name: string }, []>(`PRAGMA table_info(candidates)`).all();
  if (!candCols.some(c => c.name === "contacts_json")) {
    db.exec(`ALTER TABLE candidates ADD COLUMN contacts_json TEXT`);
  }
  if (!candCols.some(c => c.name === "outreach_status")) {
    db.exec(`ALTER TABLE candidates ADD COLUMN outreach_status TEXT`);
  }
}

// ─── Run Log ─────────────────────────────────────────────────────────────────

export function startRun(log: Omit<RunLog, "finishedAt" | "steps" | "tokens">): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO run_log (run_id, skill, prompt, started_at) VALUES (?, ?, ?, ?)`,
    [log.runId, log.skill, log.prompt, log.startedAt]
  );
}

export function finishRun(
  runId: string,
  steps: number,
  tokensTotal: number,
  error?: string
): void {
  const db = getDb();
  db.run(
    `UPDATE run_log SET finished_at=?, steps=?, tokens_total=?, error=? WHERE run_id=?`,
    [Date.now(), steps, tokensTotal, error ?? null, runId]
  );
}

// ─── Readable run ids ────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** kebab-case the spec, keep the first few words, cap length. */
function slugify(spec: string): string {
  const slug = spec.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").filter(Boolean).slice(0, 6).join("-").slice(0, 48).replace(/-+$/g, "");
  return slug || "run";
}

/**
 * Build a human-readable run id: `<spec-slug>-<MMMdd>-<n>`, e.g.
 * `senior-ml-engineer-python-pytorch-jun08-1`. The counter increments per
 * (slug, date) so repeated runs of the same role on the same day stay unique.
 */
export function nextRunId(spec: string, now: number = Date.now()): string {
  const d = new Date(now);
  const prefix = `${slugify(spec)}-${MONTHS[d.getMonth()]}${String(d.getDate()).padStart(2, "0")}`;
  const row = getDb().query<{ c: number }, [string]>(
    `SELECT COUNT(*) AS c FROM run_log WHERE run_id LIKE ?`
  ).get(prefix + "-%");
  return `${prefix}-${(row?.c ?? 0) + 1}`;
}

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
  contacts_json: string | null; outreach_status: string | null;
  notion_page_id: string | null; run_id: string | null;
}

export function getRunCandidates(runId: string): CandidateFull[] {
  return getDb().query<CandidateFull, [string]>(
    `SELECT id, linkedin_url, name, headline, location, current_role, current_company,
            skills, experience, summary, fit_score, scoring_json, outreach_json,
            contacts_json, outreach_status, notion_page_id, run_id
     FROM candidates WHERE run_id = ? ORDER BY fit_score DESC NULLS LAST`
  ).all(runId);
}

export function setKimiSessionId(runId: string, sessionId: string): void {
  getDb().run(`UPDATE run_log SET kimi_session_id = ? WHERE run_id = ?`, [sessionId, runId]);
}

// ─── Cache ───────────────────────────────────────────────────────────────────

export function cacheGet<T>(key: string): T | null {
  const db = getDb();
  const row = db.query<{ value: string; created_at: number; ttl_hours: number }, [string]>(
    `SELECT value, created_at, ttl_hours FROM cache WHERE key=?`
  ).get(key);
  if (!row) return null;
  const ageHours = (Date.now() - row.created_at) / 3_600_000;
  if (ageHours > row.ttl_hours) {
    db.run(`DELETE FROM cache WHERE key=?`, [key]);
    return null;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, value: T, ttlHours = 168): void {
  getDb().run(
    `INSERT OR REPLACE INTO cache (key, value, created_at, ttl_hours) VALUES (?, ?, ?, ?)`,
    [key, JSON.stringify(value), Date.now(), ttlHours]
  );
}

// ─── Candidates ──────────────────────────────────────────────────────────────

export interface CandidateRow {
  id: string;
  linkedin_url: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  fit_score: number | null;
  run_id: string | null;
}

export function upsertCandidate(
  id: string,
  linkedinUrl: string,
  data: Record<string, unknown>,
  runId: string
): void {
  const db = getDb();
  const now = Date.now();
  // The talent workflow calls store_candidate up to 3x per candidate (scrape →
  // score → outreach), each time with only a subset of fields. We must MERGE,
  // not overwrite: COALESCE keeps the prior value whenever this call omits a
  // field. Absent fields are passed as NULL (not "[]"/0) so COALESCE preserves
  // them — passing JSON.stringify(undefined ?? []) would clobber skills/experience.
  db.run(
    `INSERT INTO candidates (id, linkedin_url, name, headline, location, current_role, current_company,
       skills, experience, summary, fit_score, scoring_json, outreach_json, contacts_json, outreach_status, run_id, scraped_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(linkedin_url) DO UPDATE SET
       name=COALESCE(excluded.name, candidates.name),
       headline=COALESCE(excluded.headline, candidates.headline),
       location=COALESCE(excluded.location, candidates.location),
       current_role=COALESCE(excluded.current_role, candidates.current_role),
       current_company=COALESCE(excluded.current_company, candidates.current_company),
       skills=COALESCE(excluded.skills, candidates.skills),
       experience=COALESCE(excluded.experience, candidates.experience),
       summary=COALESCE(excluded.summary, candidates.summary),
       fit_score=COALESCE(excluded.fit_score, candidates.fit_score),
       scoring_json=COALESCE(excluded.scoring_json, candidates.scoring_json),
       outreach_json=COALESCE(excluded.outreach_json, candidates.outreach_json),
       contacts_json=COALESCE(excluded.contacts_json, candidates.contacts_json),
       outreach_status=COALESCE(excluded.outreach_status, candidates.outreach_status),
       run_id=excluded.run_id, updated_at=excluded.updated_at`,
    [
      id, linkedinUrl,
      (data["name"] as string | null) ?? null,
      (data["headline"] as string | null) ?? null,
      (data["location"] as string | null) ?? null,
      (data["currentRole"] as string | null) ?? null,
      (data["currentCompany"] as string | null) ?? null,
      data["skills"] !== undefined ? JSON.stringify(data["skills"]) : null,
      data["experience"] !== undefined ? JSON.stringify(data["experience"]) : null,
      (data["summary"] as string | null) ?? null,
      typeof data["fitScore"] === "number" ? data["fitScore"] : null,
      data["scoring"] ? JSON.stringify(data["scoring"]) : null,
      data["outreach"] ? JSON.stringify(data["outreach"]) : null,
      data["contacts"] ? JSON.stringify(data["contacts"]) : null,
      (data["outreachStatus"] as string | null) ?? null,
      runId, now, now,
    ]
  );
}

/** Merge a partial outreach patch (e.g. an edited linkedinMessage) into outreach_json. */
export function updateOutreach(linkedinUrl: string, patch: Record<string, unknown>): boolean {
  const db = getDb();
  const row = db.query<{ outreach_json: string | null }, [string]>(
    `SELECT outreach_json FROM candidates WHERE linkedin_url=?`
  ).get(linkedinUrl);
  if (!row) return false;
  let current: Record<string, unknown> = {};
  if (row.outreach_json) { try { current = JSON.parse(row.outreach_json); } catch { current = {}; } }
  const merged = { ...current, ...patch };
  db.run(`UPDATE candidates SET outreach_json=?, updated_at=? WHERE linkedin_url=?`,
    [JSON.stringify(merged), Date.now(), linkedinUrl]);
  return true;
}

/** Mark the outreach send status for a candidate (sent | failed | sending). */
export function setOutreachStatus(linkedinUrl: string, status: string): void {
  getDb().run(`UPDATE candidates SET outreach_status=?, updated_at=? WHERE linkedin_url=?`,
    [status, Date.now(), linkedinUrl]);
}

/** Record the Notion page id for a candidate after save_to_notion succeeds. */
export function setNotionPageId(linkedinUrl: string, pageId: string): void {
  getDb().run(
    `UPDATE candidates SET notion_page_id=?, updated_at=? WHERE linkedin_url=?`,
    [pageId, Date.now(), linkedinUrl]
  );
}

export function getTopCandidates(runId: string, limit = 10): CandidateRow[] {
  return getDb().query<CandidateRow, [string, number]>(
    `SELECT * FROM candidates WHERE run_id=? ORDER BY fit_score DESC NULLS LAST LIMIT ?`
  ).all(runId, limit);
}
