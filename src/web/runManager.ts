/**
 * talent-agent / web / runManager.ts
 * Owns the single active run: lock, handle, interrupt/steer, lifecycle broadcast.
 * Dependencies are injected so this is unit-testable without the Kimi CLI.
 */

import type { AgentEvent, TokenUsage } from "../core/types.ts";
import type { RunHandle } from "../core/agent.ts";
import { startRun, finishRun, setKimiSessionId } from "../core/memory.ts";
import { detectTodos } from "../core/agent.ts";

export class RunActiveError extends Error {}
export class NotActiveError extends Error {}

export interface LaunchParams {
  spec: string;            // role title — drives the run id + discovery terms
  jd?: string;             // optional full job description — authoritative scoring criteria
  thinking: boolean;
  notion: boolean;
  telegram: boolean;
}

export interface SendParams {
  runId: string;          // original run id (so the candidate's status updates the same row)
  linkedinUrl: string;
  name: string;
  note: string;           // the (possibly edited) outreach note to send verbatim
}

type Built = {
  config: import("../core/types.ts").AgentConfig;
  prompt: string;
  tools: import("@moonshot-ai/kimi-agent-sdk").ExternalTool[];
};

export interface RunManagerDeps {
  /** Build the kimi config + prompt + filtered tools + runId for a launch. */
  buildConfigAndPrompt: (p: LaunchParams) => Built & { runId: string };
  /** Build the focused send-outreach job (optional — sendOutreach throws if absent). */
  buildSendJob?: (p: SendParams) => Built & { jobId: string };
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
  sendOutreach(p: SendParams): { jobId: string };
  interrupt(runId: string): Promise<void>;
  steer(runId: string, message: string): Promise<void>;
  activeRunId(): string | null;
}

export function createRunManager(deps: RunManagerDeps): RunManager {
  let active: ActiveRun | null = null;

  /** Acquire the single-run lock, start the job, wire completion + cleanup. */
  function runWithLock(
    jobId: string,
    built: Built,
    onEvent: (e: AgentEvent) => void,
    onSettle: (res: { steps: number; tokens: TokenUsage } | null, err: unknown) => void,
  ): RunHandle {
    if (active) throw new RunActiveError("a run is already active");
    const handle = deps.createRun(built.config, { prompt: built.prompt, tools: built.tools, onEvent });
    active = { runId: jobId, handle };
    handle.completion
      .then(res => onSettle(res, null))
      .catch(err => onSettle(null, err))
      .finally(() => { if (active?.runId === jobId) active = null; });
    return handle;
  }

  function launch(p: LaunchParams): { runId: string } {
    const { config, prompt, tools, runId } = deps.buildConfigAndPrompt(p);
    if (active) throw new RunActiveError("a run is already active");
    startRun({ runId, skill: "talent", prompt: p.spec, startedAt: Date.now() });

    const onEvent = (e: AgentEvent) => {
      deps.broadcast({ ...e, runId });
      if (e.type === "tool_call" && e.name === "store_candidate") {
        deps.broadcast({ type: "candidates_updated", runId });
      }
      const todos = detectTodos(e);
      if (todos) deps.broadcast({ type: "todos", runId, items: todos });
    };

    const handle = runWithLock(runId, { config, prompt, tools }, onEvent, (res, err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finishRun(runId, 0, 0, msg);
        deps.broadcast({ type: "error", runId, message: msg });
      } else {
        finishRun(runId, res!.steps, res!.tokens.total);
        deps.broadcast({ type: "done", runId, steps: res!.steps, tokens: res!.tokens.total });
      }
    });

    // sessionId is typed string, but the SDK may not populate it until after the
    // initialize handshake — guard against an empty id so replay isn't keyed on "".
    if (handle.sessionId) setKimiSessionId(runId, handle.sessionId);
    return { runId };
  }

  function sendOutreach(p: SendParams): { jobId: string } {
    if (!deps.buildSendJob) throw new Error("send not configured");
    const { config, prompt, tools, jobId } = deps.buildSendJob(p);
    if (active) throw new RunActiveError("a run is already active");

    // Tag send events with the ORIGINAL runId so they surface in the current dossier's
    // live transcript; store_candidate updates the candidate's outreach_status.
    const onEvent = (e: AgentEvent) => {
      deps.broadcast({ ...e, runId: p.runId, job: "send" });
      if (e.type === "tool_call" && e.name === "store_candidate") {
        deps.broadcast({ type: "candidates_updated", runId: p.runId });
      }
    };

    runWithLock(jobId, { config, prompt, tools }, onEvent, (_res, err) => {
      const msg = err instanceof Error ? err.message : err ? String(err) : "";
      deps.broadcast({ type: "outreach_done", runId: p.runId, linkedinUrl: p.linkedinUrl, ok: !err, message: msg });
    });
    return { jobId };
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

  return { launch, sendOutreach, interrupt, steer, activeRunId: () => active?.runId ?? null };
}
