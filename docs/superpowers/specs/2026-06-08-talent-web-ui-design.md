# Talent Agent — Web UI Design

**Date:** 2026-06-08
**Status:** Approved (design)
**Topic:** A local web application that drives the talent-agent end to end — launch a run, watch it live, and browse results — replacing the CLI for day-to-day use.

## Goal

Today the agent runs only via CLI (`bun src/index.ts talent "…"`) and results are viewable only through the static `web/dashboard.html` (embedded sample data). This project makes the browser do everything the CLI does:

1. **Launch** a run from a job-spec input with thinking/notion/telegram toggles.
2. **Watch** it live: steps, token usage, context %, tool calls, and candidates appearing in the dossier as they are stored.
3. **Browse** the finished shortlist and any past run, read live from `data/talent.db`.

## Non-goals

- No authentication / multi-user support — this is a single-operator local tool.
- No network exposure — bind `127.0.0.1` only.
- No concurrent runs — one at a time (shared WebBridge Chrome session + shared run state).
- No change to the agent's scraping/scoring/outreach logic, prompts, or tools.
- No unit test of a live Kimi run (requires the real CLI + authenticated Chrome); covered by manual verification.

## Chosen approach

**In-process `Bun.serve()` + WebSocket** (vs. subprocess+SSE, vs. job-queue+poll).

The server runs `runAgent()` from `src/core/agent.ts` in-process and forwards each structured `AgentEvent` to WebSocket clients. This reuses the existing harness and event mapping, yields structured step/token/tool data for free, and keeps `data/talent.db` as the single source of truth for candidates. WebSocket is the Bun-native choice per project conventions (`CLAUDE.md`).

Rejected: **subprocess + SSE** (would re-parse ANSI stdout to recover data we already have structured in-process); **job queue + poll** (user explicitly wants a live feed).

## Kimi SDK integration

How `@moonshot-ai/kimi-agent-sdk` (v0.1.8) actually works, and how the web app uses it. This is the part that determines the whole topology.

**The SDK is a local-CLI driver, not an HTTP API client.** It `spawn`s the local `kimi` binary (path from `KIMI_EXECUTABLE`) and communicates with it over **stdin/stdout JSON-RPC** (`newSession`, prompt, events). Authentication is **OAuth against the "kimi-code" coding plan**, performed by the CLI itself — there is no `MOONSHOT_API_KEY` in the app. "Having access to the SDK" therefore means: the `kimi` binary is installed and `kimi login` has been run. `preflight()` already enforces both (`isLoggedIn()` + binary exists + runs).

**No new integration path — the server reuses `core/agent.ts`.** That module already wraps the full lifecycle: `createSession({executable, workDir, thinking, agentFile, mcpConfig, externalTools, yoloMode})` → `session.prompt(prompt)` (an async-iterable `Turn`) → `for await` over `StreamEvent`s mapped to `AgentEvent`s → `session.close()` (in `finally`, which reaps the subprocess). `src/index.ts` (CLI) calls this via `runAgent`; `src/server.ts` calls the **same** `runAgent`. The only difference is the `onEvent` sink: terminal printing for the CLI, WebSocket broadcast for the server.

**External tool handlers run in the server process, not the subprocess.** When the model calls a tool (`store_candidate`, `webbridge_*`, `save_to_notion`, `notify_recruiter`), the `kimi` subprocess sends an RPC request *up* the pipe; the SDK invokes our registered `handler` in-process and sends the result back *down*. Three consequences this design relies on:
1. `store_candidate` writes to the same `data/talent.db` the API reads → the dossier streams live with no extra plumbing (the "single source of truth").
2. `webbridge_*` issues `fetch` to `127.0.0.1:10086` *from the server* to control the user's real Chrome → the server **must** run locally.
3. Every tool call is visible in `onEvent`, so detecting `store_candidate` to emit `candidates_updated` is free.

**Toggle mapping.** `thinking` → `createSession({ thinking })`. `notion`/`telegram` → filter the `externalTools` array (drop `save_to_notion` / `notify_recruiter`) before passing — exactly as `src/index.ts` does today.

**Why the single-run lock is an SDK-level requirement.** Each run spawns its own `kimi` subprocess. Two concurrent runs would both drive the single WebBridge Chrome session `"talent"` and interleave on one WS stream. One lock → one subprocess → one browser. Bun's single-threaded async loop stays responsive during a run because the `for await` over the `Turn` yields between events; inference happens in the subprocess and remotely, never blocking `Bun.serve`.

## Architecture & safety

- New `src/server.ts` → `Bun.serve({ port, hostname: "127.0.0.1" })`. Port from `process.env.PORT ?? 3000`.
- **Single run at a time.** A module-level lock holds the active `runId`. A second `POST /api/runs` while active returns `409`.
- **Local bind only.** The server controls the user's real authenticated Chrome via WebBridge; it must never be reachable off-host.
- Launch toggles mirror the CLI flags (`--thinking`, `--no-notion`, `--no-telegram`).
  **UI defaults: thinking ON, Notion ON, Telegram ON** — all three enabled by default. The operator can toggle any of them off per run. Because launching fires real outbound sends, the `▶ LAUNCH` button shows a one-line confirm ("Launch run — Notion/Telegram enabled?") before kicking off; the confirm reflects the current toggle state.

## Components

| File | Responsibility |
|---|---|
| `src/server.ts` | `Bun.serve`: static file, JSON API, WebSocket; owns the run lock and the `onEvent` → broadcast bridge |
| `src/web/api.ts` | Pure functions: `listRuns()`, `getRunView(id)`, `normalizeCandidate(row)`. No I/O beyond the DB module. Importable by tests. |
| `src/core/agent.ts` | Refactor to add `createRun()` returning `{sessionId, turn, completion}`; `runAgent`/`runAgentStreaming` become wrappers. Extend `mapEvent` for `SubagentEvent`/`StepInterrupted`. |
| `src/core/memory.ts` | Add `listRuns()`, `getRunCandidates(runId)`; add `kimi_session_id` column to `run_log` + setter. No change to existing function signatures used by the CLI. |
| `web/dashboard.html` | Rewired: fetch API + WebSocket instead of the embedded `RUN` object. Adds launch bar, live console (with stop/steer + sub-agent tree), PLAN panel, run picker, replay. |
| `package.json` | Add `"web": "bun src/server.ts"` script. |

`server.ts` reuses existing exports: `talentSkill` (tools + `buildPrompt`), `defaultConfig`, `runAgent`, `preflight`, `startRun`, `finishRun`. The harness is not duplicated.

## API surface

| Method | Route | Behaviour |
|---|---|---|
| `GET` | `/` | Serve `web/dashboard.html` |
| `GET` | `/api/runs` | `run_log` history: `{runId, skill, prompt, startedAt, finishedAt, steps, tokensTotal, error, candidateCount}[]`, newest first |
| `GET` | `/api/runs/:id` | `{run, candidates}` where `candidates` are normalized for the dossier (see normalizer) |
| `POST` | `/api/runs` | Body `{spec, thinking?, notion?, telegram?}`. Preflight → if lock held return `409` → `startRun` → kick off `runAgent` async (not awaited) → return `{runId}`. Preflight/validation failure → `400` with message. |
| `POST` | `/api/runs/:id/interrupt` | `handle.turn.interrupt()`; `409` if `:id` is not the active run |
| `POST` | `/api/runs/:id/steer` | Body `{message}` → `handle.turn.steer(message)`; `409` if not active |
| `GET` | `/api/runs/:id/replay` | Stream mapped events from `parseSessionEvents(workDir, kimi_session_id)`; `404`/`409` if no session id stored |
| `WS` | `/ws` | Server → client broadcast of live `AgentEvent`s plus `{type:"candidates_updated", runId}` (on `store_candidate`), `{type:"todos"|"subagent"|"interrupted"}`, and `{type:"done"|"error"}` at completion. |

Tool filtering on launch mirrors `src/index.ts`: drop `save_to_notion` when `notion` is false, drop `notify_recruiter` when `telegram` is false.

## Live data flow

```
Launch → POST /api/runs
  server: preflight, acquire lock, startRun(), runAgent(config, {prompt, tools, onEvent})
  onEvent(event):
    ws.broadcast(event)                              // step / status / tool_call / text
    if event.type === "tool_call" && event.name === "store_candidate":
        ws.broadcast({ type:"candidates_updated", runId })
  on finish: finishRun(...), ws.broadcast({type:"done"|"error"}), release lock

client WS handler:
  "step"/"status"/"tool_call"/"text"  → update live console (step N · tokens · ctx% · last tool)
  "candidates_updated"                → GET /api/runs/:id → re-render dossier (new entries animate)
  "done"/"error"                      → unlock launch UI, final fetch + render
```

The WebSocket carries progress and a "re-fetch" nudge only; candidate content always comes from the DB via `/api/runs/:id`. A mid-run dossier and a freshly loaded one render through the identical path.

## Candidate normalizer

`normalizeCandidate(row)` maps a `candidates` DB row → the renderer's shape:

```
{ name, score, role, company, loc, url, hook, gates, li, email }
```

- `score` ← `fit_score` (may be null → render as "—", no tier styling).
- `gates` ← parse `scoring_json`; expect per-gate values (Skills/Seniority/Location/Recency/Standout). If absent or unparseable → omit gates; the gate block hides.
- `li` / `email` / `hook` ← parse `outreach_json` (`linkedinMessage`, `emailBody`, `personalHook`). If absent → memo toggle hidden.
- `role`/`company`/`loc` ← `current_role` / `current_company` / `location`.
- **Graceful degradation:** a scrape-only row (no score, no outreach) still renders as a valid dossier entry. Malformed JSON in `scoring_json`/`outreach_json` is caught and treated as absent, never throws.

The same logic is mirrored client-side so the live re-render and any client-only transforms agree with the server.

## Frontend changes (`web/dashboard.html`, single file)

- **Launch bar** under the masthead: job-spec text input, three toggle chips (thinking / notion / telegram — all default on), `▶ LAUNCH` button. Disabled while a run is active. Same dossier visual language (mono labels, ink + vermilion accent).
- **Live console** (collapsible strip): `step N · {tokens} tok · ctx {n}%` and the last tool call, driven by the WebSocket. Reuses existing signal-bar/mono styling.
- **Run picker** in the masthead meta: `<select>` populated from `/api/runs`; changing it re-fetches and re-renders.
- **Data source:** on load, `GET /api/runs` → populate picker → fetch latest run → render. The embedded `RUN` object is removed; a minimal inline fallback remains only for when the API is unreachable (file still opens standalone).
- The dossier renderer (rank entries, gates, score, memo) is unchanged; only its input source changes.

## Extended Kimi capabilities (interrupt/steer, sub-agents, todos, replay)

Four additional Kimi features surfaced in the web UI. Each is grounded in a concrete SDK API verified in `index.d.ts` / `schema.d.ts` (v0.1.8).

### Prerequisite refactor: expose a run handle

`turn.interrupt()` / `turn.steer()` require the live `Turn`, which `runAgent` currently hides. Refactor `core/agent.ts` to add:

```
createRun(config, {prompt, tools, onEvent}) → {
   sessionId: string,          // session.sessionId — persisted for replay
   turn: Turn,                 // for interrupt()/steer()
   completion: Promise<{summary, steps, tokens}>
}
```

`createRun` creates the session, calls `session.prompt()`, drives the `for await` loop (firing `onEvent`) inside `completion`, and closes the session in `finally`. `runAgent`/`runAgentStreaming` become thin wrappers that `await handle.completion` — **the CLI is unchanged**. `server.ts` keeps the full handle in its run-lock state so it can interrupt/steer and so it knows the `sessionId`.

### 1. Interrupt & Steer

- **API:** `POST /api/runs/:id/interrupt` → `handle.turn.interrupt()`. `POST /api/runs/:id/steer {message}` → `handle.turn.steer(message)`. Both `409` if `:id` is not the active run.
- **UI:** a `■ STOP` button and a steer input in the live console (only while a run is active). Steer messages echo into the console as `↳ steer: …`.
- A `StepInterrupted` event (empty payload) is mapped to `{type:"interrupted"}` and broadcast so the UI reflects the stop.

### 2. Sub-agents live view

- **API:** none — rides the existing WS stream.
- **Mapping:** `mapEvent` currently drops `SubagentEvent`. Map it by recursively mapping its inner `.event` (a `WireEvent`) and tagging the result with `parentToolCallId` (from `parent_tool_call_id`). New event: `{type:"subagent", parentToolCallId, inner: AgentEvent}`.
- **UI:** sub-agent events render indented under their parent tool call in the live console (a nested activity tree). Does not affect the dossier.

### 3. Live todos + background tasks

- **API:** none — rides the WS stream.
- **Mapping:** the agent's plan arrives via its `SetTodoList` tool call (built-in Kimi tool from `agent.yaml`); the arguments carry `TodoBlock`-shaped `items:[{title, status}]`. `server.ts` detects `tool_call` with name `SetTodoList`, parses items, and broadcasts `{type:"todos", items}`. Background tasks (`TaskList`/`TaskOutput`) surface as ordinary tool-call lines.
- **UI:** a PLAN checklist panel beside the live console, re-rendered on each `todos` event (☑ done / ▣ in_progress / ☐ pending).

### 4. Replay / scrub past runs

- **Prerequisite:** persist the Kimi `sessionId`. Add column `kimi_session_id TEXT` to `run_log`; `startRun` writes it once `createRun` returns (small follow-up update, or pass it into `startRun`). `getRunView` returns it.
- **API:** `GET /api/runs/:id/replay` → look up `kimi_session_id`, call `parseSessionEvents(workDir, sessionId)`, map each `StreamEvent` through the existing `mapEvent`, and stream the mapped events to the client (paced) so the live console replays steps/tokens/tools in order. Returns `409`/`404` if no session id is stored (e.g. runs created before this feature).
- **UI:** a `⏮ REPLAY` button next to the run picker; replaying drives the same live-console renderer used for live runs, with a step progress indicator.

### Event model additions (summary)

`AgentEvent` gains: `interrupted`, `subagent` (with `parentToolCallId` + `inner`), `todos` (with `items`). `mapEvent` stops returning `null` for `SubagentEvent` and `StepInterrupted`. All additions are backward-compatible — existing consumers ignore unknown event types.

## Error handling

- **Preflight failure** (Kimi missing / not logged in): `POST /api/runs` → `400` + message → shown in launch bar.
- **Run throws mid-flight:** `finishRun(runId, steps, tokens, error)`, WS `{type:"error", message}`, UI unlocks and displays the error; partial candidates already in the DB remain visible.
- **WebSocket drop:** client auto-reconnects with backoff and re-fetches the current run; no state is lost because the DB is authoritative.
- **Double launch:** `409` → inline "a run is already active".
- **Unknown route:** `404`.

## Testing

`bun test`, each suite against an isolated temp DB (`TALENT_DB_PATH` set before import, as in `memory.test.ts`):

- `normalizeCandidate`: full row; scrape-only row (no score/outreach); malformed `scoring_json`/`outreach_json` (must not throw, must degrade).
- `listRuns` / `getRunCandidates`: correct ordering, candidate counts, and field mapping against seeded rows.
- Launch lock: acquiring while held is rejected; releasing allows the next acquire. (Lock unit extracted so it can be tested without a live run.)
- `mapEvent` additions: a `SubagentEvent` produces `{type:"subagent", parentToolCallId, inner}` with a correctly-mapped inner event; `StepInterrupted` → `{type:"interrupted"}`; a `SetTodoList` tool call is recognized and yields `{type:"todos", items}`.
- `kimi_session_id` persistence round-trips through `run_log` and `getRunView`.
- Interrupt/steer/replay routes: unit-test the active-run guard (`409` when `:id` is not active) and the replay `404` when no session id is stored. The live `turn.interrupt()`/`steer()` calls themselves are covered by manual verification.

**Manual verification (documented, not automated):** start `bun run web`, open `http://127.0.0.1:3000`, launch a small run with notion/telegram off, confirm live console advances and candidates stream into the dossier, switch to a past run via the picker.

## Rollout / impact

- Additive: no existing file behaviour changes except `web/dashboard.html` (data source) and two new `memory.ts` exports.
- The CLI (`src/index.ts`) continues to work unchanged.
- New dependency footprint: none — `Bun.serve` and `WebSocket` are built in.
